"""Select a physical CTAP2 HID authenticator, skipping U2F-only apps such as Ethereum."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Protocol

# fido2.hid.CAPABILITY.CBOR — CTAP2 over CTAPHID.
CTAP_HID_CBOR = 0x04


class HidDevice(Protocol):
    capabilities: int

    def close(self) -> None: ...


def pick_ctap2_device(devices: Iterable[HidDevice]) -> tuple[HidDevice | None, list[HidDevice]]:
    chosen: HidDevice | None = None
    skipped: list[HidDevice] = []
    for device in devices:
        if chosen is None and getattr(device, "capabilities", 0) & CTAP_HID_CBOR:
            chosen = device
        else:
            skipped.append(device)
    return chosen, skipped


def collect_hid_devices(list_devices: Callable[[], Iterable[HidDevice]]) -> list[HidDevice]:
    devices: list[HidDevice] = []
    try:
        stream = list_devices()
    except OSError:
        return devices
    iterator = iter(stream)
    while True:
        try:
            devices.append(next(iterator))
        except StopIteration:
            return devices
        except OSError:
            return devices


def wait_for_ctap2_device(
    list_devices: Callable[[], Iterable[HidDevice]],
    *,
    timeout_s: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
    warn: Callable[[str], None],
) -> HidDevice:
    deadline = clock() + timeout_s
    while True:
        chosen, skipped = pick_ctap2_device(collect_hid_devices(list_devices))
        for device in skipped:
            closer = getattr(device, "close", None)
            if closer is not None:
                closer()
        if chosen is not None:
            return chosen
        if clock() >= deadline:
            raise RuntimeError(
                "No CTAP2 Security Key. Quit Ethereum (both-button Quit), open the Security Key app, keep USB connected.",
            )
        warn("Waiting for the Security Key app (CTAP2). Quit Ethereum first.")
        sleep(1)
