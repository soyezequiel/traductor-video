import json

from fastapi.testclient import TestClient

from doblaje import api as module
from doblaje.config import Settings


def test_pairing_requires_code_and_protects_status(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "settings", Settings(root=tmp_path, data=tmp_path / "data",
                                                     models=tmp_path / "models"))
    module.PAIR_ATTEMPTS.clear()
    with TestClient(module.app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/v1/status").status_code == 401
        assert client.post("/v1/pair", json={"code": module.PAIRING_CODE},
                           headers={"Origin": "https://www.youtube.com"}).status_code == 403
        response = client.post("/v1/pair", json={"code": module.PAIRING_CODE},
                               headers={"Origin": "chrome-extension://" + "a" * 32})
        assert response.status_code == 200
        token = response.json()["token"]
        assert client.get("/v1/status", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        assert client.post("/v1/pair", json={"code": module.PAIRING_CODE}).json()["token"] != token


def test_one_time_websocket_ticket(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "settings", Settings(root=tmp_path, data=tmp_path / "data",
                                                     models=tmp_path / "models"))
    with TestClient(module.app) as client:
        token = client.post("/v1/pair", json={"code": module.PAIRING_CODE}).json()["token"]
        ticket = client.post("/v1/ws-ticket", headers={"Authorization": f"Bearer {token}"}).json()["ticket"]
        with client.websocket_connect("/v1/events") as ws:
            ws.send_json({"ticket": ticket})
            assert ws.receive_json()["type"] == "hello"
        with client.websocket_connect("/v1/events") as ws:
            ws.send_json({"ticket": ticket})
            assert ws.receive()["type"] == "websocket.close"
