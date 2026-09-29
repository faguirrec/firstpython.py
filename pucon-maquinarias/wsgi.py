"""Punto de entrada para gunicorn (`gunicorn wsgi:app`) y para el CLI de Flask."""
from app import create_app

app = create_app()
