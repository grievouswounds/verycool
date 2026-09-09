#!/usr/bin/env python3
"""Exercise the pinned Ledger Security Key ELF through Speculos' TCP HID endpoint."""

import json
import os
import sys

source = os.environ.get("AQUA_LEDGER_SECURITY_KEY_SOURCE")
output = os.environ.get("AQUA_E2E_REPORT")
if not source or not output:
    raise RuntimeError("Security Key CTAP evidence environment is incomplete")

sys.path.insert(0, os.path.join(source, "tests"))
from functional.transport import TransportType  # noqa: E402
from functional.transport.hid import LedgerCtapHidDevice  # noqa: E402
from fido2.ctap2 import Ctap2  # noqa: E402

device = LedgerCtapHidDevice(TransportType.U2F)
try:
    info = Ctap2(device).get_info()
finally:
    device.close()

versions = list(info.versions)
if "U2F_V2" not in versions or "FIDO_2_0" not in versions:
    raise RuntimeError(f"Unexpected Security Key versions: {versions!r}")
if info.aaguid.hex() != "58b44d0b0a7cf33afd48f7153c871352":
    raise RuntimeError(f"Unexpected Nano S Plus AAGUID: {info.aaguid.hex()}")
if not info.options.get("up") or not info.options.get("uv") or not info.options.get("rk"):
    raise RuntimeError(f"Security Key is missing required CTAP2 options: {info.options!r}")

with open(output, "w", encoding="utf-8") as handle:
    json.dump({
        "transport": "Speculos TCP CTAPHID/U2F",
        "versions": versions,
        "aaguid": info.aaguid.hex(),
        "options": dict(info.options),
        "maxMessageSize": info.max_msg_size,
    }, handle, indent=2, sort_keys=True)
    handle.write("\n")
