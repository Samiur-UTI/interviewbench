"""The payments pods' path to the Stripe values follows docs/standards/vault-clients.md, and the
values have no other home in this repo."""

import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
VAULT = ROOT / "vault"
PROD_ROLES = sorted((VAULT / "auth" / "k8s-quay-prod-fra1" / "role").glob("*.json"))
VAULT_IMAGE = re.compile(r"registry\.quayside\.example/mirror/hashicorp/vault:(?!latest$)[\w.-]+")
STRIPE_NAMES = ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET")


def seconds(value):
    if isinstance(value, int):
        return value
    total = 0
    for number, unit in re.findall(r"(\d+)([hms]?)", str(value)):
        total += int(number) * {"h": 3600, "m": 60, "s": 1, "": 1}[unit]
    return total


def objects(folder="deploy/k8s"):
    for path in sorted((ROOT / folder).rglob("*.y*ml")):
        with path.open(encoding="utf-8") as handle:
            yield from (doc for doc in yaml.safe_load_all(handle) if doc)


def find(kind, name, namespace="payments"):
    [found] = [o for o in objects() if o["kind"] == kind and o["metadata"]["name"] == name
               and o["metadata"].get("namespace") == namespace]
    return found


def pod_spec():
    return find("Deployment", "payments-api")["spec"]["template"]["spec"]


def agent_containers(spec):
    containers = spec.get("initContainers", []) + spec["containers"]
    return [c for c in containers if "agent" in c.get("command", []) + c.get("args", [])]


def agent_config(spec):
    """The agent configuration files the agent containers are given, as text."""
    [volume] = [v for v in spec["volumes"] if v["name"] == "vault-agent-config"]
    return find("ConfigMap", volume["configMap"]["name"])["data"]


# Vault: role and policy (rules 1 to 4)

@pytest.mark.parametrize("path", PROD_ROLES, ids=lambda p: p.stem)
def test_roles_are_bound_to_one_service_account_with_audience_vault(path):
    role = json.loads(path.read_text(encoding="utf-8"))
    names, namespaces = role["bound_service_account_names"], role["bound_service_account_namespaces"]
    assert len(names) == 1 and len(namespaces) == 1, "one service account in one namespace"
    assert "*" not in names[0] + namespaces[0] and names[0] != "default"
    assert role.get("audience") == "vault"


@pytest.mark.parametrize("path", PROD_ROLES, ids=lambda p: p.stem)
def test_role_tokens_are_short_lived(path):
    role = json.loads(path.read_text(encoding="utf-8"))
    assert 0 < seconds(role.get("token_ttl", 0)) <= 20 * 60
    assert 0 < seconds(role.get("token_max_ttl", 0)) <= 4 * 3600


@pytest.mark.parametrize("path", PROD_ROLES, ids=lambda p: p.stem)
def test_each_role_has_its_own_exact_read_only_policy(path):
    role = json.loads(path.read_text(encoding="utf-8"))
    assert role["token_policies"] == [path.stem]
    namespace = role["bound_service_account_namespaces"][0]
    policy = (VAULT / "sys" / "policies" / "acl" / f"{path.stem}.hcl").read_text(encoding="utf-8")
    rules = re.findall(r'path\s+"([^"]+)"\s*{\s*capabilities\s*=\s*\[([^\]]*)\]\s*}', policy)
    assert rules and len(rules) == policy.count("path ")
    for secret, capabilities in rules:
        assert secret.startswith(f"kv/data/{namespace}/") and not re.search(r"[*+]", secret), secret
        assert re.findall(r'"(\w+)"', capabilities) == ["read"], secret


# The pod (rules 2, 5 to 8)

def test_payments_pods_run_as_their_own_service_account_without_automounted_tokens():
    spec = pod_spec()
    account = spec.get("serviceAccountName", "default")
    assert account != "default"
    assert find("ServiceAccount", account).get("automountServiceAccountToken") is False
    assert spec.get("automountServiceAccountToken") is False


def test_only_the_agents_mount_the_vault_token():
    spec = pod_spec()
    token_volumes = {}
    for volume in spec["volumes"]:
        for source in volume.get("projected", {}).get("sources", []):
            if "serviceAccountToken" in source:
                token_volumes[volume["name"]] = source["serviceAccountToken"]
    assert token_volumes, "no projected token for Vault"
    for token in token_volumes.values():
        assert token.get("audience") == "vault" and 600 <= token.get("expirationSeconds", 3600) <= 3600
    agents = [c["name"] for c in agent_containers(spec)]
    for container in spec.get("initContainers", []) + spec["containers"]:
        mounted = {m["name"] for m in container.get("volumeMounts", [])} & set(token_volumes)
        assert not mounted or container["name"] in agents, container["name"]


def test_agents_verify_the_platform_vault_and_write_no_token_file():
    config = agent_config(pod_spec())["agent.hcl"]
    assert 'address = "https://vault.platform.quayside.example:8200"' in config
    assert re.search(r'ca_cert\s*=\s*"/vault/ca/ca.crt"', config)
    assert "tls_skip_verify" not in config and "sink" not in config


def test_credentials_are_rendered_privately_onto_memory():
    spec = pod_spec()
    config = agent_config(spec)["agent.hcl"]
    perms = re.findall(r'perms\s*=\s*"?(0?[0-7]{3})"?', config)
    assert perms and all(int(p, 8) & 0o007 == 0 for p in perms), perms
    [destination] = re.findall(r'destination\s*=\s*"([^"]+)"', config)
    [app] = [c for c in spec["containers"] if c["name"] == "payments"]
    assert {"name": "STRIPE_CREDENTIALS_FILE", "value": destination} in app["env"]
    [mount] = [m for m in app["volumeMounts"] if destination.startswith(m["mountPath"] + "/")]
    [volume] = [v for v in spec["volumes"] if v["name"] == mount["name"]]
    assert volume.get("emptyDir", {}).get("medium") == "Memory"
    assert spec["securityContext"]["fsGroup"] == app["securityContext"]["runAsGroup"]


def test_agents_run_the_pinned_mirrored_vault_image_as_non_root():
    agents = agent_containers(pod_spec())
    assert agents
    for container in agents:
        assert VAULT_IMAGE.fullmatch(container["image"]), container["image"]
        security = container["securityContext"]
        assert security["runAsNonRoot"] and security["readOnlyRootFilesystem"]
        assert security["allowPrivilegeEscalation"] is False and security["capabilities"]["drop"] == ["ALL"]


def test_the_credentials_are_in_place_before_the_payments_container_starts():
    init_agents = [c for c in pod_spec().get("initContainers", []) if c in agent_containers(pod_spec())]
    assert init_agents and all("-exit-after-auth" in c["command"] for c in init_agents)


# One home for the values

def test_the_stripe_values_have_no_home_in_ci_or_deploy():
    found = []
    for folder in ("ci", "deploy"):
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file():
                for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                    code = re.sub(r"(^|\s)#.*$", "", line)
                    found += [f"{path.relative_to(ROOT)}:{number}" for name in STRIPE_NAMES if name in code]
    assert not found, found
    assert not [o for o in objects() if o["kind"] == "Secret" and o["metadata"].get("namespace") == "payments"]
