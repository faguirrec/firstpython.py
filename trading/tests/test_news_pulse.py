"""NewsPulse tests: deduplication, persistence and classification."""

from __future__ import annotations

from datetime import timedelta

import pytest

from conftest import BASE_TIME, FakeBroker
from trading_bot.agents.news_pulse import NewsPulse, _extract_json
from trading_bot.brokers.base import NewsArticle
from trading_bot.config import Settings
from trading_bot.db import Store


def article(headline: str, symbols=("AAPL",), source="alpaca", **kwargs) -> NewsArticle:
    return NewsArticle(
        external_id=kwargs.get("external_id", headline[:12]),
        headline=headline,
        summary=kwargs.get("summary", ""),
        url=kwargs.get("url", "https://example.test/a"),
        author=kwargs.get("author", "wire"),
        source=source,
        symbols=tuple(symbols),
        published_at=kwargs.get("published_at", BASE_TIME),
    )


@pytest.fixture()
def pulse(settings: Settings, store: Store, broker: FakeBroker) -> NewsPulse:
    return NewsPulse(settings, store, broker)


def test_ingest_stores_articles(pulse: NewsPulse, broker: FakeBroker, store: Store):
    broker.news = [article("Apple beats earnings"), article("Microsoft cuts guidance", ("MSFT",))]
    assert pulse.ingest() == 2
    assert len(store.unclassified_news(limit=10)) == 2


def test_the_same_story_from_two_sources_is_stored_once(pulse: NewsPulse, broker: FakeBroker):
    broker.news = [
        article("Apple beats earnings", source="alpaca"),
        article("Apple  BEATS   earnings!", source="finnhub", external_id="other"),
    ]
    assert pulse.ingest() == 1


def test_articles_outside_the_universe_are_skipped(pulse: NewsPulse, broker: FakeBroker):
    broker.news = [article("Some biotech doubles", symbols=())]
    assert pulse.ingest() == 0


def test_a_failing_source_does_not_break_ingestion(pulse: NewsPulse, broker: FakeBroker, store: Store):
    def explode(*_args, **_kwargs):
        raise RuntimeError("news api down")

    broker.get_news = explode
    assert pulse.ingest() == 0
    assert store.recent_events(kind="news_source_failed")


def test_classification_falls_back_to_the_lexicon_without_an_api_key(
    pulse: NewsPulse, broker: FakeBroker, store: Store
):
    broker.news = [article("Apple beats estimates and raises dividend")]
    pulse.ingest()
    results = pulse.classify_pending()

    assert len(results) == 1
    assert results[0].symbol == "AAPL"
    assert results[0].sentiment_score > 0
    # The fallback must never claim LLM-grade confidence.
    assert results[0].confidence <= 0.35
    assert results[0].model == "lexicon-fallback"


def test_negative_headline_scores_negative(pulse: NewsPulse, broker: FakeBroker):
    broker.news = [article("Apple faces lawsuit and probe after recall")]
    pulse.ingest()
    assert pulse.classify_pending()[0].sentiment_score < 0


def test_rumors_are_flagged(pulse: NewsPulse, broker: FakeBroker):
    broker.news = [article("Apple reportedly in talks, sources say, to buy a rival")]
    pulse.ingest()
    assert pulse.classify_pending()[0].is_rumor is True


def test_classified_items_are_not_reprocessed(pulse: NewsPulse, broker: FakeBroker, store: Store):
    broker.news = [article("Apple beats estimates")]
    pulse.ingest()
    assert len(pulse.classify_pending()) == 1
    assert pulse.classify_pending() == []
    assert store.unclassified_news() == []


def test_sentiment_is_persisted_and_readable_by_symbol(pulse: NewsPulse, broker: FakeBroker, store: Store):
    broker.news = [article("Apple beats estimates and raises guidance")]
    pulse.ingest()
    pulse.classify_pending()

    stored = store.recent_sentiment("AAPL", hours=24 * 365 * 10)
    assert len(stored) == 1
    assert stored[0]["symbol"] == "AAPL"
    assert stored[0]["published_at"]


def test_llm_response_parsing_rejects_unknown_ids_and_tickers(pulse: NewsPulse, store: Store):
    items = [{"id": 7, "headline": "x", "symbols": ["AAPL"], "published_at": BASE_TIME.isoformat()}]
    payload = """```json
    {"results": [
      {"id": 7, "ticker": "AAPL", "sentiment_score": 0.7, "confidence": 0.8,
       "horizon": "days", "one_liner": "good", "is_rumor": false},
      {"id": 7, "ticker": "ZZZZ", "sentiment_score": 0.9, "confidence": 0.9},
      {"id": 999, "ticker": "AAPL", "sentiment_score": -0.9, "confidence": 0.9}
    ]}
    ```"""
    results = pulse._parse_results(payload, items)
    assert len(results) == 1
    assert results[0].symbol == "AAPL"
    assert results[0].sentiment_score == pytest.approx(0.7)


def test_llm_scores_are_clamped(pulse: NewsPulse):
    items = [{"id": 1, "headline": "x", "symbols": ["AAPL"]}]
    results = pulse._parse_results(
        '{"results": [{"id": 1, "ticker": "AAPL", "sentiment_score": 9, "confidence": 5}]}', items
    )
    assert results[0].sentiment_score == 1.0
    assert results[0].confidence == 1.0


def test_extract_json_handles_prose_around_the_object():
    assert _extract_json('Sure! {"results": []} hope that helps') == {"results": []}
    assert _extract_json("no json here") == {}


def test_run_cycle_reports_both_stages(pulse: NewsPulse, broker: FakeBroker):
    broker.news = [article("Apple beats estimates")]
    assert pulse.run_cycle() == {"ingested": 1, "classified": 1}
