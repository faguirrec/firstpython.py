"""Autonomous multi-agent trading system built on the Alpaca API.

Agents:
    NewsPulse     - news ingestion and LLM sentiment classification.
    TraderCore    - signal fusion, order generation and execution.
    RiskSentinel  - net expected value, position sizing and hard risk limits.
    LearningLoop  - nightly review of closed trades and signal-weight updates.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
