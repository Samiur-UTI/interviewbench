import pytest

from payments.config import ConfigError, Settings, load_settings

KEY = "sk_test_fake-unit-key"
WEBHOOK_SECRET = "whsec_fake-unit-secret"


def env(**overrides):
    values = {"STRIPE_SECRET_KEY": KEY, "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET}
    values.update(overrides)
    return {name: value for name, value in values.items() if value is not None}


def test_reads_both_stripe_values():
    settings = load_settings(env())
    assert settings.stripe_secret_key == KEY
    assert settings.stripe_webhook_secret == WEBHOOK_SECRET


def test_defaults():
    settings = load_settings(env())
    assert settings.stripe_api_base == "https://api.stripe.com"
    assert settings.port == 8080


def test_optional_values_are_read():
    settings = load_settings(env(STRIPE_API_BASE="http://127.0.0.1:12111/", PORT="9090"))
    assert settings.stripe_api_base == "http://127.0.0.1:12111"
    assert settings.port == 9090


@pytest.mark.parametrize("name", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
@pytest.mark.parametrize("value", [None, ""])
def test_missing_stripe_value_is_an_error(name, value):
    with pytest.raises(ConfigError, match=name):
        load_settings(env(**{name: value}))


@pytest.mark.parametrize("port", ["http", "-1", "70000"])
def test_bad_port_is_an_error(port):
    with pytest.raises(ConfigError, match="PORT"):
        load_settings(env(PORT=port))


def test_bad_api_base_is_an_error():
    with pytest.raises(ConfigError, match="STRIPE_API_BASE"):
        load_settings(env(STRIPE_API_BASE="api.stripe.com"))


def test_settings_are_immutable():
    settings = load_settings(env())
    assert isinstance(settings, Settings)
    with pytest.raises(AttributeError):
        settings.port = 1
