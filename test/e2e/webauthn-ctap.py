#!/usr/bin/env python3
"""Create or assert a WebAuthn credential against Speculos or a physical Ledger Security Key."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
import urllib.request

source = os.environ.get("AQUA_LEDGER_SECURITY_KEY_SOURCE")
if source:
    sys.path.insert(0, os.path.join(source, "tests"))

from fido2.ctap2 import Ctap2  # noqa: E402


def b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def from_b64url(value: str) -> bytes:
    import base64
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


def mash_buttons(api_url: str, stop: threading.Event) -> None:
    if not api_url:
        print("webauthn-ctap: no Speculos API URL; not pressing buttons", file=sys.stderr)
        return
    print(f"webauthn-ctap: watching {api_url}", file=sys.stderr)
    press_body = json.dumps({"action": "press-and-release"}).encode("ascii")
    confirm_lines = {"register", "log in", "hold to approve", "hold to sign"}

    def press(button: str) -> None:
        request = urllib.request.Request(
            f"{api_url.rstrip('/')}/button/{button}",
            data=press_body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=1).read()

    def screen_lines() -> list[str]:
        request = urllib.request.Request(f"{api_url.rstrip('/')}/events?currentscreenonly=true")
        raw = urllib.request.urlopen(request, timeout=1).read().decode("utf-8")
        body = json.loads(raw)
        events = body["events"] if isinstance(body, dict) and "events" in body else body
        if not isinstance(events, list):
            return []
        return [str(event.get("text", "")).strip() for event in events if isinstance(event, dict)]

    last = ""
    while not stop.wait(0.2):
        try:
            lines = [line for line in screen_lines() if line]
            text = "\n".join(lines)
            if text != last:
                print(f"webauthn-ctap screen:\n{text}", file=sys.stderr)
                last = text
            lowered = [line.lower() for line in lines]
            if any("password-less" in line or "two-factor" in line for line in lowered):
                continue
            confirm = any(
                line in confirm_lines or line.startswith("log in user ")
                for line in lowered
            )
            press("both" if confirm else "right")
        except Exception as error:
            print(f"webauthn-ctap button loop: {error}", file=sys.stderr)
            try:
                press("right")
            except Exception:
                continue


def open_device():
    physical = os.environ.get("AQUA_E2E_PHYSICAL") == "1"
    if physical:
        from fido2.hid import CtapHidDevice
        devices = list(CtapHidDevice.list_devices())
        if not devices:
            raise RuntimeError("No physical CTAPHID Security Key is connected")
        return devices[0]
    from functional.transport import TransportType  # noqa: E402
    from functional.transport.hid import LedgerCtapHidDevice  # noqa: E402
    os.environ.setdefault("SPECULOS_HOST", "127.0.0.1")
    os.environ.setdefault("SPECULOS_PORT", os.environ.get("AQUA_SECURITY_KEY_HID_PORT", "5001"))
    return LedgerCtapHidDevice(TransportType.U2F)


def client_data(kind: str, challenge: str, origin: str) -> bytes:
    return json.dumps(
        {"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": False},
        separators=(",", ":"),
    ).encode("utf-8")


def attestation_object_bytes(attestation) -> bytes:
    if isinstance(attestation, (bytes, bytearray)):
        return bytes(attestation)
    obj = getattr(attestation, "attestation_object", None)
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj)
    if obj is not None:
        try:
            return bytes(obj)
        except Exception:
            pass
    fmt = getattr(attestation, "fmt", None)
    auth_data = getattr(attestation, "auth_data", None)
    att_stmt = getattr(attestation, "att_stmt", None)
    if fmt is not None and auth_data is not None and att_stmt is not None:
        from fido2.webauthn import AttestationObject
        return bytes(AttestationObject.create(fmt, auth_data, att_stmt))
    raise RuntimeError(f"Cannot encode CTAP attestation of type {type(attestation)!r}")


def credential_id_from_assertion(assertion, allow: list) -> bytes:
    credential = getattr(assertion, "credential", None)
    if isinstance(credential, dict):
        identifier = credential.get("id") or credential.get(b"id")
        if identifier is not None:
            return bytes(identifier)
    auth_data = getattr(assertion, "auth_data", None)
    credential_data = getattr(auth_data, "credential_data", None) if auth_data is not None else None
    if credential_data is not None:
        return bytes(credential_data.credential_id)
    if allow:
        return bytes(allow[0]["id"])
    raise RuntimeError("CTAP assertion did not include a credential id")


def main() -> None:
    request = json.load(sys.stdin)
    origin = request["origin"]
    rp_id = request["rpId"]
    challenge = request["challenge"]
    api_url = os.environ.get("AQUA_SECURITY_KEY_SPECULOS_URL", "")
    stop = threading.Event()
    masher = threading.Thread(target=mash_buttons, args=(api_url, stop), daemon=True)
    device = open_device()
    try:
        connection = getattr(device, "_connection", None)
        sock = getattr(connection, "sock", None)
        if sock is not None:
            sock.settimeout(120)
        ctap = Ctap2(device)
        masher.start()
        digest = hashlib.sha256(client_data(
            "webauthn.create" if request["mode"] == "create" else "webauthn.get",
            challenge,
            origin,
        )).digest()
        if request["mode"] == "create":
            user_id = from_b64url(request["userId"])
            attestation = ctap.make_credential(
                digest,
                {"id": rp_id, "name": request.get("rpName", "Aqua Ledger MCP")},
                {"id": user_id, "name": request["userName"], "displayName": request["userName"]},
                [{"type": "public-key", "alg": -7}],
                None,
                None,
                {"rk": True, "uv": True},
            )
            credential_id = bytes(attestation.auth_data.credential_data.credential_id)
            attestation_bytes = attestation_object_bytes(attestation)
            payload = {
                "id": b64url(credential_id),
                "rawId": b64url(credential_id),
                "type": "public-key",
                "authenticatorAttachment": "cross-platform",
                "clientExtensionResults": {},
                "response": {
                    "clientDataJSON": b64url(client_data("webauthn.create", challenge, origin)),
                    "attestationObject": b64url(attestation_bytes),
                    "transports": ["usb"],
                },
            }
        else:
            allow = [{"type": "public-key", "id": from_b64url(item["id"])} for item in request.get("allowCredentials", [])]
            assertion = ctap.get_assertion(rp_id, digest, allow or None, None, {"up": True, "uv": True})
            credential_id = credential_id_from_assertion(assertion, allow)
            user = getattr(assertion, "user", None)
            user_handle = None if user is None else user.get("id") if isinstance(user, dict) else None
            auth_data = bytes(assertion.auth_data)
            signature = bytes(assertion.signature)
            payload = {
                "id": b64url(credential_id),
                "rawId": b64url(credential_id),
                "type": "public-key",
                "authenticatorAttachment": "cross-platform",
                "clientExtensionResults": {},
                "response": {
                    "clientDataJSON": b64url(client_data("webauthn.get", challenge, origin)),
                    "authenticatorData": b64url(auth_data),
                    "signature": b64url(signature),
                    "userHandle": None if user_handle is None else b64url(bytes(user_handle)),
                },
            }
        json.dump(payload, sys.stdout)
        sys.stdout.write("\n")
    finally:
        stop.set()
        try:
            device.close()
        except Exception:
            pass
        time.sleep(0.2)


if __name__ == "__main__":
    main()
