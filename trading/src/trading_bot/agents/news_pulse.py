"""NewsPulse - news ingestion and sentiment classification.

Pipeline: fetch (Alpaca News API, optionally Finnhub/NewsAPI as redundant
sources) -> deduplicate across providers -> classify with Claude -> persist.

Persistence is the point: LearningLoop grades these scores weeks later, so a
sentiment reading that only lived in memory would be worthless.

Classification output per article/ticker::

    {"ticker": "AAPL", "sentiment_score": -0.6, "confidence": 0.8,
     "horizon": "intraday", "one_liner": "...", "is_rumor": false}
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable, Sequence

from ..brokers.base import NewsArticle
from ..clock import iso, to_utc, utcnow
from ..config import Settings
from ..db import Store
from ..db.store import content_hash
from ..logging_setup import get_logger

log = get_logger(__name__)

CLASSIFIER_SYSTEM = (
    "You are a financial news analyst for an automated US equities trading system. "
    "You classify headlines for their likely short-term price impact on specific tickers. "
    "You are strict: most news is noise and deserves a score near zero. "
    "Answer with JSON only."
)

CLASSIFIER_TEMPLATE = """Classify each news item below for its short-term impact on US-listed equities.

Return a JSON object shaped exactly like:
{{"results": [{{"id": <item id>, "ticker": "AAPL", "sentiment_score": -1.0..1.0,
  "confidence": 0.0..1.0, "horizon": "intraday|days|weeks",
  "one_liner": "max 15 words", "is_rumor": true|false}}]}}

Rules:
- Only emit entries for tickers in this watchlist: {universe}.
- One entry per (item, ticker) pair that is genuinely affected. Skip items with no clear impact.
- sentiment_score is the expected direction of the price move, not how nice the news sounds.
- confidence reflects how reliably this news moves the price: routine coverage, opinion pieces,
  and analyst chatter are low confidence.
- Set is_rumor=true for unconfirmed reports, "sources say", or speculation without an official source.

News items:
{items}
"""

# Fallback lexicon used when no Anthropic key is configured. It is deliberately
# crude: it keeps the pipeline runnable end to end, never pretends to be an LLM.
_POSITIVE = {
    "beats", "beat", "surge", "surges", "soars", "record", "upgrade", "upgraded", "raises",
    "raised", "approval", "approved", "wins", "win", "outperform", "buyback", "profit",
    "growth", "strong", "rally", "rallies", "jumps", "boost", "expands", "dividend",
}
_NEGATIVE = {
    "miss", "misses", "plunge", "plunges", "falls", "downgrade", "downgraded", "cuts", "cut",
    "lawsuit", "probe", "investigation", "recall", "warns", "warning", "layoffs", "loss",
    "losses", "weak", "slump", "bankruptcy", "halt", "halted", "fraud", "delays", "delay",
}
_RUMOR_MARKERS = ("rumor", "rumour", "sources say", "reportedly", "speculation", "said to be")


@dataclass(frozen=True)
class ClassifiedSentiment:
    news_id: int
    symbol: str
    sentiment_score: float
    confidence: float
    horizon: str
    one_liner: str
    is_rumor: bool
    model: str


class NewsPulse:
    """Ingests news and turns it into persisted, per-ticker sentiment."""

    def __init__(self, settings: Settings, store: Store, broker: Any | None = None) -> None:
        self.settings = settings
        self.store = store
        self.broker = broker
        self._anthropic: Any = None

    # ----------------------------------------------------------------- ingest
    def ingest(self, *, lookback_hours: float = 6.0, limit: int = 50) -> int:
        """Fetch from every configured source and store the new items.

        Returns the number of genuinely new articles (duplicates are dropped).
        """
        since = utcnow() - timedelta(hours=lookback_hours)
        articles: list[NewsArticle] = []
        for fetch, name in self._sources():
            try:
                fetched = fetch(since, limit)
                articles.extend(fetched)
                log.info("news_fetched", extra={"event": {"source": name, "count": len(fetched)}})
            except Exception as exc:  # noqa: BLE001 - one bad source must not stop the rest
                log.warning("news_source_failed", extra={"event": {"source": name, "error": str(exc)}})
                self.store.record_event(
                    "news_source_failed", str(exc), severity="warning", source=name
                )

        stored = 0
        for article in articles:
            if self._store_article(article) is not None:
                stored += 1
        if stored:
            log.info("news_stored", extra={"event": {"new_items": stored, "seen": len(articles)}})
        return stored

    def _sources(self) -> list[tuple[Any, str]]:
        sources: list[tuple[Any, str]] = []
        if self.broker is not None:
            sources.append((self._fetch_alpaca, "alpaca"))
        if self.settings.news_api_key:
            provider = self.settings.news_provider
            if provider == "finnhub":
                sources.append((self._fetch_finnhub, "finnhub"))
            elif provider == "newsapi":
                sources.append((self._fetch_newsapi, "newsapi"))
        return sources

    def _fetch_alpaca(self, since: datetime, limit: int) -> list[NewsArticle]:
        return self.broker.get_news(symbols=self.settings.universe, since=since, limit=limit)

    def _fetch_finnhub(self, since: datetime, limit: int) -> list[NewsArticle]:
        """Company news from Finnhub (one request per symbol, date-ranged)."""
        articles: list[NewsArticle] = []
        start = to_utc(since).date().isoformat()
        end = utcnow().date().isoformat()
        for symbol in self.settings.universe:
            params = urllib.parse.urlencode(
                {"symbol": symbol, "from": start, "to": end, "token": self.settings.news_api_key}
            )
            payload = _get_json(f"https://finnhub.io/api/v1/company-news?{params}")
            for row in (payload or [])[:limit]:
                published = row.get("datetime")
                articles.append(
                    NewsArticle(
                        external_id=str(row.get("id", "")),
                        headline=str(row.get("headline", "")),
                        summary=str(row.get("summary", "")),
                        url=str(row.get("url", "")),
                        author=str(row.get("source", "")),
                        source="finnhub",
                        symbols=(symbol,),
                        published_at=(
                            datetime.fromtimestamp(published, tz=to_utc(utcnow()).tzinfo)
                            if isinstance(published, (int, float)) and published
                            else None
                        ),
                    )
                )
        return articles

    def _fetch_newsapi(self, since: datetime, limit: int) -> list[NewsArticle]:
        """Headlines from NewsAPI.org, matched back to watchlist tickers."""
        query = " OR ".join(self.settings.universe)
        params = urllib.parse.urlencode(
            {
                "q": query,
                "from": to_utc(since).isoformat(),
                "language": "en",
                "sortBy": "publishedAt",
                "pageSize": min(limit, 100),
                "apiKey": self.settings.news_api_key,
            }
        )
        payload = _get_json(f"https://newsapi.org/v2/everything?{params}") or {}
        articles: list[NewsArticle] = []
        for row in payload.get("articles", [])[:limit]:
            headline = str(row.get("title", ""))
            summary = str(row.get("description", "") or "")
            symbols = tuple(
                symbol
                for symbol in self.settings.universe
                if re.search(rf"\b{re.escape(symbol)}\b", f"{headline} {summary}", re.IGNORECASE)
            )
            if not symbols:
                continue
            published = row.get("publishedAt")
            articles.append(
                NewsArticle(
                    external_id=str(row.get("url", "")),
                    headline=headline,
                    summary=summary,
                    url=str(row.get("url", "")),
                    author=str((row.get("source") or {}).get("name", "")),
                    source="newsapi",
                    symbols=symbols,
                    published_at=(
                        datetime.fromisoformat(published.replace("Z", "+00:00"))
                        if isinstance(published, str) and published
                        else None
                    ),
                )
            )
        return articles

    def _store_article(self, article: NewsArticle) -> int | None:
        symbols = [s for s in article.symbols if s in set(self.settings.universe)] or list(
            article.symbols
        )
        if not symbols:
            return None
        return self.store.insert_news(
            {
                "source": article.source,
                "external_id": article.external_id,
                # Hash headline + tickers so the same story from two providers collapses.
                "content_hash": content_hash(article.headline, ",".join(sorted(symbols))),
                "headline": article.headline,
                "summary": article.summary,
                "url": article.url,
                "author": article.author,
                "symbols": symbols,
                "published_at": iso(article.published_at) if article.published_at else iso(),
                "fetched_at": iso(),
            }
        )

    # --------------------------------------------------------------- classify
    def classify_pending(self, *, batch_size: int = 12) -> list[ClassifiedSentiment]:
        """Classify stored-but-unscored news and persist the results."""
        pending = self.store.unclassified_news(limit=batch_size)
        if not pending:
            return []

        try:
            results = self._classify(pending)
        except Exception as exc:  # noqa: BLE001 - fall back rather than stall the pipeline
            log.warning("llm_classification_failed", extra={"event": {"error": str(exc)}})
            self.store.record_event("llm_classification_failed", str(exc), severity="warning")
            results = [r for item in pending for r in self._heuristic_classify(item)]

        for result in results:
            self.store.insert_sentiment(
                {
                    "news_id": result.news_id,
                    "symbol": result.symbol,
                    "sentiment_score": result.sentiment_score,
                    "confidence": result.confidence,
                    "horizon": result.horizon,
                    "one_liner": result.one_liner,
                    "is_rumor": result.is_rumor,
                    "model": result.model,
                    "published_at": _published_of(pending, result.news_id),
                }
            )
        for item in pending:
            self.store.mark_news_classified(int(item["id"]))

        log.info(
            "news_classified",
            extra={"event": {"items": len(pending), "sentiment_rows": len(results)}},
        )
        return results

    def _classify(self, items: Sequence[dict[str, Any]]) -> list[ClassifiedSentiment]:
        client = self._anthropic_client()
        if client is None:
            return [r for item in items for r in self._heuristic_classify(item)]

        rendered = "\n".join(
            f"- id={item['id']} | tickers={','.join(item.get('symbols') or [])} | "
            f"{item.get('headline', '')} | {(item.get('summary') or '')[:280]}"
            for item in items
        )
        prompt = CLASSIFIER_TEMPLATE.format(
            universe=", ".join(self.settings.universe), items=rendered
        )
        response = client.messages.create(
            model=self.settings.anthropic_model,
            max_tokens=2000,
            system=CLASSIFIER_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        return self._parse_results(text, items)

    def _parse_results(
        self, text: str, items: Sequence[dict[str, Any]]
    ) -> list[ClassifiedSentiment]:
        payload = _extract_json(text)
        rows = payload.get("results", []) if isinstance(payload, dict) else []
        valid_ids = {int(item["id"]) for item in items}
        universe = set(self.settings.universe)
        out: list[ClassifiedSentiment] = []
        for row in rows:
            try:
                news_id = int(row["id"])
                symbol = str(row["ticker"]).upper()
            except (KeyError, TypeError, ValueError):
                continue
            if news_id not in valid_ids or (universe and symbol not in universe):
                continue
            out.append(
                ClassifiedSentiment(
                    news_id=news_id,
                    symbol=symbol,
                    sentiment_score=_clamp(float(row.get("sentiment_score", 0.0)), -1.0, 1.0),
                    confidence=_clamp(float(row.get("confidence", 0.0)), 0.0, 1.0),
                    horizon=str(row.get("horizon", "intraday")),
                    one_liner=str(row.get("one_liner", ""))[:200],
                    is_rumor=bool(row.get("is_rumor", False)),
                    model=self.settings.anthropic_model,
                )
            )
        return out

    def _heuristic_classify(self, item: dict[str, Any]) -> list[ClassifiedSentiment]:
        """Lexicon fallback so the system still runs without an LLM key."""
        text = f"{item.get('headline', '')} {item.get('summary') or ''}".lower()
        words = set(re.findall(r"[a-z']+", text))
        positives = len(words & _POSITIVE)
        negatives = len(words & _NEGATIVE)
        if positives == negatives:
            score = 0.0
        else:
            score = _clamp((positives - negatives) / max(positives + negatives, 1), -1.0, 1.0)
        is_rumor = any(marker in text for marker in _RUMOR_MARKERS)
        # Low ceiling on purpose: a word list should never size a position like an LLM read.
        confidence = 0.0 if score == 0 else min(0.35, 0.15 * (positives + negatives))
        return [
            ClassifiedSentiment(
                news_id=int(item["id"]),
                symbol=symbol.upper(),
                sentiment_score=score,
                confidence=confidence,
                horizon="intraday",
                one_liner=str(item.get("headline", ""))[:200],
                is_rumor=is_rumor,
                model="lexicon-fallback",
            )
            for symbol in (item.get("symbols") or [])
        ]

    def _anthropic_client(self) -> Any | None:
        if not self.settings.anthropic_api_key:
            return None
        if self._anthropic is None:
            try:
                import anthropic
            except ImportError:
                log.warning("anthropic_sdk_missing")
                return None
            self._anthropic = anthropic.Anthropic(api_key=self.settings.anthropic_api_key)
        return self._anthropic

    # ------------------------------------------------------------------ read
    def sentiment_for(self, symbol: str, *, hours: float = 24.0) -> list[dict[str, Any]]:
        return self.store.recent_sentiment(symbol, hours=hours)

    def run_cycle(self, *, lookback_hours: float = 6.0) -> dict[str, Any]:
        """Ingest then classify - the unit of work the scheduler calls."""
        ingested = self.ingest(lookback_hours=lookback_hours)
        classified = self.classify_pending()
        return {"ingested": ingested, "classified": len(classified)}


# -------------------------------------------------------------------- helpers
def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _published_of(items: Iterable[dict[str, Any]], news_id: int) -> str | None:
    for item in items:
        if int(item["id"]) == news_id:
            return item.get("published_at")
    return None


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model response."""
    if not text:
        return {}
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        candidate = text[start : end + 1] if start != -1 and end > start else ""
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _get_json(url: str, *, timeout: float = 15.0) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "trading-bot/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"news request failed: {exc}") from exc
