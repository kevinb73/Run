"""Crée (ou retrouve) le serveur Run Coach chez Hetzner via leur API.

Usage : HETZNER_TOKEN=... python deploy.py <api_key> [branche]
Le serveur s'installe tout seul (cloud-init) et sert l'API en HTTPS sur <ip>.sslip.io.
"""

import json
import os
import sys
import urllib.request
from pathlib import Path

API = "https://api.hetzner.cloud/v1"
NAME = "runcoach"
TYPE, LOCATION, IMAGE = "cpx11", "nbg1", "ubuntu-24.04"


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", f"Bearer {os.environ.get('HETZNER_TOKEN', 'proxy-injected')}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")


def firewall_id():
    existing = call("GET", f"/firewalls?name={NAME}")["firewalls"]
    if existing:
        return existing[0]["id"]
    rules = [{"direction": "in", "protocol": "tcp", "port": p, "source_ips": ["0.0.0.0/0", "::/0"]} for p in ("80", "443")]
    rules.append({"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"]})
    return call("POST", "/firewalls", {"name": NAME, "rules": rules})["firewall"]["id"]


def main():
    api_key, branch = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "main")
    existing = call("GET", f"/servers?name={NAME}")["servers"]
    if existing:
        srv = existing[0]
    else:
        user_data = (Path(__file__).parent / "cloud-init.yaml").read_text()
        user_data = user_data.replace("__API_KEY__", api_key).replace("__BRANCH__", branch)
        srv = call("POST", "/servers", {
            "name": NAME, "server_type": TYPE, "location": LOCATION, "image": IMAGE,
            "user_data": user_data, "firewalls": [{"firewall": firewall_id()}],
            "labels": {"app": "runcoach"},
            "public_net": {"enable_ipv4": True, "enable_ipv6": True},
        })["server"]
    ip = srv["public_net"]["ipv4"]["ip"]
    print(json.dumps({"id": srv["id"], "status": srv["status"], "ip": ip, "url": f"https://{ip.replace('.', '-')}.sslip.io"}))


if __name__ == "__main__":
    main()
