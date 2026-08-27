"""Persistence layer (SQLite for the pilot, Postgres-shaped schema for later)."""

from .store import Store, connect

__all__ = ["Store", "connect"]
