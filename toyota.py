"""Run the upstream Toyota client independently of Home Assistant."""
import argparse
import asyncio
from getpass import getpass
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType

COMMANDS = {"lock": "DoorLock", "unlock": "DoorUnlock", "start": "EngineStart"}


def save_session(path, tokens, device_id):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent, mode="w", encoding="utf-8", delete=False
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump({"tokens": tokens, "device_id": device_id}, stream)
            stream.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def load_client_modules(directory):
    # The upstream package initializer imports Home Assistant. Its transport
    # and vehicle modules can be imported through their own package namespace.
    if not (directory / "client.py").is_file():
        raise FileNotFoundError("Set the Toyota client directory.")
    package = ModuleType("_homebridge_toyota_client")
    package.__path__ = [str(directory)]
    sys.modules[package.__name__] = package


async def run(args):
    from _homebridge_toyota_client.auth import ToyotaOneAuth
    from _homebridge_toyota_client.client import ToyotaOneClient
    from _homebridge_toyota_client.vehicle import RemoteRequestCommand
    from _homebridge_toyota_client.vehicle_discovery import get_vehicles

    if args.action == "login":
        if not sys.stdin.isatty():
            raise RuntimeError("Run login interactively.")
        auth = ToyotaOneAuth()
        user = input("Toyota account email: ").strip()
        password = getpass("Toyota password (leave empty for OTP-only login): ")
        code = await auth.authorize(user, password)
        if isinstance(code, dict):
            code = await auth.authorize(user, password, getpass("Toyota verification code: "))
        if not isinstance(code, str) or not code:
            raise RuntimeError("Toyota did not issue an authorization code.")
        await auth.request_tokens(code)
        save_session(args.session, auth.get_tokens(), auth.get_device_id())
        return {"signedIn": True}

    try:
        persisted = json.loads(args.session.read_text(encoding="utf-8"))
        auth = ToyotaOneAuth()
        auth.set_tokens(persisted["tokens"])
        auth.set_device_id(persisted["device_id"])
    except (OSError, ValueError, TypeError, KeyError):
        fail("SESSION")

    # Keep refresh-token rotation durable before sending a vehicle command.
    await auth.check_tokens()
    save_session(args.session, auth.get_tokens(), auth.get_device_id())
    auth = ToyotaOneAuth(
        initial_tokens=auth.get_tokens(),
        callback=lambda tokens: save_session(args.session, tokens, auth.get_device_id()),
    )
    auth.set_device_id(persisted["device_id"])
    client = ToyotaOneClient(auth=auth)
    if args.action == "vehicles":
        return [
            {key: vehicle.get(key) for key in ("modelName", "modelYear", "vin", "generation")}
            for vehicle in await client.get_user_vehicle_list()
        ]

    # Restrict discovery to the selected VIN before the upstream status reads.
    class SelectedVehicleClient(ToyotaOneClient):
        async def get_user_vehicle_list(self):
            vehicles = await super().get_user_vehicle_list()
            if not isinstance(vehicles, list):
                raise RuntimeError("Toyota returned no vehicle list.")
            return [
                row for row in vehicles
                if isinstance(row, dict) and row.get("vin") == args.vin
            ]

    vehicles = await get_vehicles(SelectedVehicleClient(auth=auth))
    if len(vehicles) != 1:
        fail("VEHICLE")
    vehicle = vehicles[0]
    if args.action == "status":
        return {"locked": vehicle.doors_locked}
    await vehicle.send_command(RemoteRequestCommand[COMMANDS[args.action]])
    return {"submitted": True}


def fail(category):
    print(f"TOYOTA_{category}", file=sys.stderr)
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("client_directory", type=Path)
    parser.add_argument("session", type=Path)
    parser.add_argument("action", choices=["login", "vehicles", "status", *COMMANDS])
    parser.add_argument("vin", nargs="?")
    args = parser.parse_args()
    if args.action in {"status", *COMMANDS} and not args.vin:
        parser.error("This operation requires a VIN.")
    logging.disable(logging.CRITICAL)
    if os.name != "nt":
        os.umask(0o077)
    try:
        load_client_modules(args.client_directory.resolve())
        result = asyncio.run(run(args))
    except (ImportError, FileNotFoundError):
        fail("CLIENT")
    except Exception:
        fail("SESSION" if args.action == "login" else "COMMAND")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
