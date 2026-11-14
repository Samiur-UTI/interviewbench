import json

import pytest

from payments.config import ConfigError, Settings, load_settings

KEY = "sk_test_fake-unit-key"
WEBHOOK_SECRET = "whsec_fake-unit-secret"


@pytest.fixture
def credentials_file(tmp_path):
    """Write `content` (bytes, or a value to dump as JSON) to a credentials file; return its path."""
    def write(content=None, name="stripe.json"):
        if content is None:
            content = {"secret_key": KEY, "webhook_secret": WEBHOOK_SECRET}
        path = tmp_path / name
        path.write_bytes(content if isinstance(content, bytes) else json.dumps(content).encode())
        return path
    return write


def env(path, **overrides):
    values = {"STRIPE_CREDENTIALS_FILE": None if path is None else str(path)}
    values.update(overrides)
    return {name: value for name, value in values.items() if value is not None}


def test_reads_both_stripe_values_from_the_file(credentials_file):
    settings = load_settings(env(credentials_file()))
    assert settings.stripe_secret_key == KEY
    assert settings.stripe_webhook_secret == WEBHOOK_SECRET


def test_other_fields_in_the_file_are_ignored(credentials_file):
    path = credentials_file({"secret_key": KEY, "webhook_secret": WEBHOOK_SECRET, "rolled_by": "finance"})
    assert load_settings(env(path)).stripe_secret_key == KEY


def test_values_with_json_special_characters_are_read_as_written(credentials_file):
    odd_key = 'sk_test_fake-"quoted"\\back'
    path = credentials_file({"secret_key": odd_key, "webhook_secret": WEBHOOK_SECRET})
    assert load_settings(env(path)).stripe_secret_key == odd_key


def test_defaults(credentials_file):
    settings = load_settings(env(credentials_file()))
    assert settings.stripe_api_base == "https://api.stripe.com"
    assert settings.port == 8080


def test_optional_values_are_read(credentials_file):
    settings = load_settings(env(credentials_file(), STRIPE_API_BASE="http://127.0.0.1:12111/", PORT="9090"))
    assert settings.stripe_api_base == "http://127.0.0.1:12111"
    assert settings.port == 9090


def test_the_environment_never_supplies_the_stripe_values(credentials_file):
    path = credentials_file()
    settings = load_settings(env(path, STRIPE_SECRET_KEY="sk_test_fake-env", STRIPE_WEBHOOK_SECRET="whsec_fake-env"))
    assert settings.stripe_secret_key == KEY
    with pytest.raises(ConfigError, match="STRIPE_CREDENTIALS_FILE"):
        load_settings({"STRIPE_SECRET_KEY": KEY, "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET})


@pytest.mark.parametrize("value", [None, "", "stripe.json"])
def test_unset_empty_or_relative_path_is_an_error(value):
    with pytest.raises(ConfigError, match="STRIPE_CREDENTIALS_FILE"):
        load_settings(env(value))


def test_missing_file_is_an_error(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(env(tmp_path / "missing.json"))


def test_a_folder_instead_of_a_file_is_an_error(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(env(tmp_path))


@pytest.mark.parametrize("content", [
    b"", b"secret_key=sk_test_fake-unit-key", b'{"secret_key": "sk_test_fa', b"\xff\xfe{}",
    b"null", b"42", b'"sk_test_fake-unit-key"', b'["sk_test_fake-unit-key"]',
], ids=["empty", "not-json", "cut-off", "not-utf8", "null", "number", "string", "list"])
def test_content_that_is_not_a_json_object_is_an_error(credentials_file, content):
    with pytest.raises(ConfigError):
        load_settings(env(credentials_file(content)))


@pytest.mark.parametrize("fields", [
    {"webhook_secret": WEBHOOK_SECRET}, {"secret_key": KEY},
    {"secret_key": "", "webhook_secret": WEBHOOK_SECRET}, {"secret_key": KEY, "webhook_secret": " "},
    {"secret_key": 42, "webhook_secret": WEBHOOK_SECRET}, {"secret_key": KEY, "webhook_secret": None},
    {"secret_key": [KEY], "webhook_secret": WEBHOOK_SECRET},
], ids=["no-key", "no-webhook-secret", "empty-key", "blank-webhook-secret", "number", "null", "list"])
def test_a_missing_empty_or_non_string_field_is_an_error(credentials_file, fields):
    with pytest.raises(ConfigError):
        load_settings(env(credentials_file(fields)))


@pytest.mark.parametrize("content", [
    {"secret_key": KEY, "webhook_secret": ""}, {"secret_key": "", "webhook_secret": WEBHOOK_SECRET},
    b'{"secret_key": "sk_test_fake-unit-key", "webhook_secret": "whsec_fa',
    b"secret_key=sk_test_fake-unit-key\nwebhook_secret=whsec_fake-unit-secret",
])
def test_errors_never_quote_the_file(credentials_file, content):
    with pytest.raises(ConfigError) as caught:
        load_settings(env(credentials_file(content)))
    assert KEY not in repr(caught.value) and WEBHOOK_SECRET not in repr(caught.value)


@pytest.mark.parametrize("port", ["http", "-1", "70000"])
def test_bad_port_is_an_error(credentials_file, port):
    with pytest.raises(ConfigError, match="PORT"):
        load_settings(env(credentials_file(), PORT=port))


def test_bad_api_base_is_an_error(credentials_file):
    with pytest.raises(ConfigError, match="STRIPE_API_BASE"):
        load_settings(env(credentials_file(), STRIPE_API_BASE="api.stripe.com"))


def test_settings_are_immutable_and_do_not_show_the_values(credentials_file):
    settings = load_settings(env(credentials_file()))
    assert isinstance(settings, Settings)
    with pytest.raises(AttributeError):
        settings.port = 1
    for text in (repr(settings), str(settings)):
        assert KEY not in text and WEBHOOK_SECRET not in text
