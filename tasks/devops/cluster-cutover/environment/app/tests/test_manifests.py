"""Everything the pipeline applies at least parses."""

import json
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def files(folder, *patterns):
    return sorted(path for pattern in patterns for path in (ROOT / folder).rglob(pattern))


def label(path):
    return path.relative_to(ROOT).as_posix()


K8S = files("deploy/k8s", "*.yaml", "*.yml")
INFRA = files("infra", "*.yaml", "*.yml")
VAULT_JSON = files("vault", "*.json")


def load_yaml(path):
    with path.open(encoding="utf-8") as handle:
        return [doc for doc in yaml.safe_load_all(handle) if doc is not None]


def test_there_is_something_to_check():
    assert K8S and INFRA and VAULT_JSON


@pytest.mark.parametrize("path", K8S, ids=label)
def test_kubernetes_manifest_parses(path):
    for doc in load_yaml(path):
        assert isinstance(doc, dict), f"{label(path)}: a document is not a mapping"
        assert doc.get("apiVersion") and doc.get("kind"), f"{label(path)}: apiVersion or kind missing"
        assert doc.get("metadata", {}).get("name"), f"{label(path)}: {doc['kind']} without a name"


@pytest.mark.parametrize("path", [*INFRA, ROOT / "ci" / "pipeline.yaml"], ids=label)
def test_yaml_parses(path):
    assert load_yaml(path), f"{label(path)} is empty"


@pytest.mark.parametrize("path", VAULT_JSON, ids=label)
def test_vault_json_parses(path):
    with path.open(encoding="utf-8") as handle:
        assert isinstance(json.load(handle), dict), f"{label(path)} is not a JSON object"


def test_firewall_rules_have_the_documented_fields():
    [doc] = load_yaml(ROOT / "infra" / "firewall" / "rules.yaml")
    for firewall in doc["firewalls"]:
        assert firewall["apply_to"]["role"] in {"control-plane", "worker"}, firewall["name"]
        for rule in firewall["inbound"]:
            assert rule["protocol"] in {"tcp", "udp"}, rule
            assert str(rule["ports"]).replace("-", "", 1).isdigit(), rule
            assert rule["sources"], rule
