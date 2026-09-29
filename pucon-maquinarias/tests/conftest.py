import os
import re

import pytest

from app import create_app
from app.extensions import db
from app.seed import crear_admin


@pytest.fixture()
def app(tmp_path):
    """SQLite temporal; con TEST_DATABASE_URL se prueba contra PostgreSQL (se vacía)."""
    uri = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}"
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": uri})
    with app.app_context():
        db.drop_all()
        db.create_all()
        crear_admin("admin@pucon.cl", "clave-segura-1", "Admin")
    yield app
    with app.app_context():
        db.session.remove()
        db.engine.dispose()


class Cliente:
    """Cliente HTTP que se encarga del token CSRF."""

    def __init__(self, app):
        self.c = app.test_client()

    def _token(self, url="/login"):
        html = self.c.get(url).get_data(as_text=True)
        m = re.search(r'name="_csrf" value="([^"]+)"', html)
        assert m, f"sin token CSRF en {url}"
        return m.group(1)

    def login(self, email="admin@pucon.cl", clave="clave-segura-1"):
        return self.c.post("/login", data={"email": email, "password": clave, "_csrf": self._token()})

    def get(self, url, **kw):
        return self.c.get(url, **kw)

    def post(self, url, data=None, token_url="/", **kw):
        data = dict(data or {})
        data["_csrf"] = self._token(token_url)
        return self.c.post(url, data=data, **kw)


@pytest.fixture()
def cli(app):
    c = Cliente(app)
    assert c.login().status_code == 302
    return c
