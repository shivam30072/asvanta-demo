import json

import httpx
import pytest
import respx

from asvanta_gateway.sms import Msg91Provider, SmsMessage, TwilioProvider, share_message


def test_message_format_and_length():
    link = "https://app.asvanta.in/#/s/" + "A" * 32
    text = share_message("Asvanta Diagnostics", "CT", "Cardiac (Calcium score + CTA)", True, link, "123456", 72)
    assert text.startswith("Asvanta Diagnostics: your CT")
    assert text.endswith(f"View: {link} OTP 123456. Valid 72 h.")
    assert len(text) <= 160
    long = share_message("Asvanta Diagnostics", "MRI", "Lumbosacral spine with whole spine screening sagittal", False, link, "123456", 720)
    assert len(long) <= 160 and "MRI images are ready" in long


def test_msg91_request_construction():
    p = Msg91Provider("AUTHKEY", "TPL123", "ASVNTA")
    req = p.build_request(SmsMessage("+919876543210", "body", {"otp": "123456", "link": "https://x"}))
    assert req.url == "https://control.msg91.com/api/v5/flow"
    assert req.headers["authkey"] == "AUTHKEY"
    body = json.loads(req.content)
    assert body["template_id"] == "TPL123" and body["sender"] == "ASVNTA"
    assert body["recipients"] == [{"mobiles": "919876543210", "otp": "123456", "link": "https://x"}]


@pytest.mark.anyio
async def test_msg91_send_mocked():
    with respx.mock() as m:
        route = m.post("https://control.msg91.com/api/v5/flow").respond(json={"type": "success", "message": "req-1"})
        res = await Msg91Provider("K", "T").send(SmsMessage("+919876543210", "hi"))
    assert route.called and res.ok and res.message_id == "req-1"


def test_twilio_request_construction():
    p = TwilioProvider("ACabc", "secret", "+15005550006")
    req = p.build_request(SmsMessage("+919876543210", "hello there"))
    assert str(req.url) == "https://api.twilio.com/2010-04-01/Accounts/ACabc/Messages.json"
    assert req.headers["authorization"].startswith("Basic ")
    form = dict(x.split("=", 1) for x in req.content.decode().split("&"))
    assert form["To"] == "%2B919876543210" and form["From"] == "%2B15005550006" and form["Body"] == "hello+there"


@pytest.mark.anyio
async def test_twilio_send_failure_mocked():
    with respx.mock() as m:
        m.post(url__regex=r"https://api.twilio.com/.*").respond(400, json={"message": "bad number"})
        res = await TwilioProvider("ACabc", "secret", "+1500").send(SmsMessage("+919876543210", "x"))
    assert not res.ok and "bad number" in res.detail


def test_providers_need_keys():
    with pytest.raises(ValueError):
        Msg91Provider("", "")
    with pytest.raises(ValueError):
        TwilioProvider("", "", "")


@pytest.fixture
def anyio_backend():
    return "asyncio"
