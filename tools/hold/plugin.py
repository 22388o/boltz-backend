#!/usr/bin/env /tools/.venv/bin/python3
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from hashlib import sha256
from typing import Any, ClassVar, TypeVar

from pyln.client import Plugin, RpcError
from pyln.client.plugin import Request

# TODO: fix shebang line
# TODO: restart handling

PLUGIN_NAME = "hold"

TIMEOUT_CANCEL = 60
TIMEOUT_CHECK_INTERVAL = 10


class DataErrorCodes(int, Enum):
    KeyDoesNotExist = 1200
    KeyExists = 1202


class HtlcFailureMessage(str, Enum):
    MppTimeout = "0017"
    IncorrectPaymentDetails = "400F"


class InvoiceState(str, Enum):
    Paid = "paid"
    Unpaid = "unpaid"
    Accepted = "accepted"
    Cancelled = "cancelled"


class HoldInvoiceStateError(ValueError):
    def __init__(self, old_state: InvoiceState, new_state: InvoiceState) -> None:
        msg = f"illegal hold invoice state transition ({old_state} -> {new_state})"
        super(ValueError, self).__init__(msg)

        self.error = {
            "code": 2103,
            "message": msg,
        }


class Errors:
    invoice_exists: ClassVar[dict[str, Any]] = {
        "code": 2101,
        "message": "hold invoice with that payment hash exists already",
    }
    invoice_not_exists: ClassVar[dict[str, Any]] = {
        "code": 2102,
        "message": "hold invoice with that payment hash does not exist",
    }


POSSIBLE_STATE_TRANSITIONS = {
    InvoiceState.Paid: [],
    InvoiceState.Cancelled: [],
    InvoiceState.Accepted: [InvoiceState.Cancelled, InvoiceState.Paid],
    InvoiceState.Unpaid: [InvoiceState.Accepted, InvoiceState.Cancelled],
}

HoldInvoiceType = TypeVar("HoldInvoiceType", bound="HoldInvoice")


@dataclass
class HoldInvoice:
    state: InvoiceState
    bolt11: str
    payment_hash: str
    payment_preimage: str | None

    def set_state(self, new_state: InvoiceState) -> None:
        if new_state not in POSSIBLE_STATE_TRANSITIONS[self.state]:
            raise HoldInvoiceStateError(self.state, new_state)

        self.state = new_state

    def to_json(self) -> str:
        return json.dumps(
            self.__dict__,
            default=lambda x: x.value if isinstance(x, Enum) else x,
        )

    @classmethod
    def from_json(cls: type[HoldInvoiceType], json_str: str) -> HoldInvoiceType:
        json_dict = json.loads(json_str)
        return cls(**json_dict)


def time_now() -> datetime:
    return datetime.now(tz=timezone.utc)


T = TypeVar("T")


def partition(iterable: list[T], pred: Callable[[T], bool]) -> tuple[list[T], list[T]]:
    trues = []
    falses = []

    for item in iterable:
        if pred(item):
            trues.append(item)
        else:
            falses.append(item)

    return trues, falses


@dataclass
class Htlc:
    msat: int
    request: Request
    creation_time: datetime


class Htlcs:
    htlcs: list[Htlc]

    def __init__(self, invoice_amount: int) -> None:
        self.htlcs = []
        self.invoice_amount = invoice_amount

    def add_htlc(self, htlc_msat: int, req: Request) -> None:
        self.htlcs.append(Htlc(htlc_msat, req, time_now()))

    def is_fully_paid(self) -> bool:
        return self.invoice_amount <= sum(h.msat for h in self.htlcs)

    def requests(self) -> list[Request]:
        return [h.request for h in self.htlcs]

    def cancel_expired(self) -> None:
        expired, not_expired = partition(
            self.htlcs,
            lambda htlc: (
                                 time_now() - htlc.creation_time
                         ).total_seconds() > TIMEOUT_CANCEL,
        )

        self.htlcs = not_expired
        for h in expired:
            Settler.fail_callback(h.request, HtlcFailureMessage.MppTimeout)


class Settler:
    _plugin: Plugin
    _lock = threading.Lock()
    _htlcs: ClassVar[dict[str, Htlcs]] = {}

    def __init__(self, plugin: Plugin) -> None:
        self._plugin = plugin
        self._start_timeout_interval()

    def handle_htlc(
            self,
            invoice: HoldInvoice,
            dec_invoice: dict[str, Any],
            htlc_msat: int,
            req: Request,
    ) -> None:
        with self._lock:
            if invoice.state == InvoiceState.Paid:
                self._settle_callback(req, invoice.payment_preimage)
                return

            if invoice.state == InvoiceState.Cancelled:
                self.fail_callback(req, HtlcFailureMessage.IncorrectPaymentDetails)
                return

            if invoice.payment_hash not in self._htlcs:
                invoice_msat = int(dec_invoice["amount_msat"])
                self._htlcs[invoice.payment_hash] = Htlcs(invoice_msat)

            htlcs = self._htlcs[invoice.payment_hash]
            htlcs.add_htlc(htlc_msat, req)

            if not htlcs.is_fully_paid():
                return

            invoice.set_state(InvoiceState.Accepted)
            ds.save_invoice(invoice, mode="must-replace")
            self._plugin.log(
                f"Accepted hold invoice {invoice.payment_hash} "
                f"with {len(htlcs.htlcs)} HTLCs",
            )

    def settle(self, invoice: HoldInvoice) -> None:
        invoice.set_state(InvoiceState.Paid)
        for req in self._pop_requests(invoice.payment_hash):
            self._settle_callback(req, invoice.payment_preimage)

    def cancel(self, invoice: HoldInvoice) -> None:
        invoice.set_state(InvoiceState.Cancelled)
        for req in self._pop_requests(invoice.payment_hash):
            self.fail_callback(req, HtlcFailureMessage.IncorrectPaymentDetails)

    def _pop_requests(self, payment_hash: str) -> list[Request]:
        return self._htlcs.pop(payment_hash, Htlcs(0)).requests()

    def _start_timeout_interval(self) -> None:
        self._stop_timeout_interval = threading.Event()

        def loop() -> None:
            while not self._stop_timeout_interval.wait(TIMEOUT_CHECK_INTERVAL):
                self._timeout_handler()

        threading.Thread(target=loop).start()

    def _timeout_handler(self) -> None:
        with self._lock:
            for htlcs in self._htlcs.values():
                if not htlcs.is_fully_paid():
                    htlcs.cancel_expired()

    @staticmethod
    def fail_callback(req: Request, message: HtlcFailureMessage) -> None:
        req.set_result({
            "result": "fail",
            "failure_message": message,
        })

    @staticmethod
    def continue_callback(req: Request) -> None:
        req.set_result({
            "result": "continue",
        })

    @staticmethod
    def _settle_callback(req: Request, preimage: str) -> None:
        req.set_result({
            "result": "resolve",
            "payment_key": preimage,
        })


class DataStore:
    _plugin: Plugin
    _invoices_key = "invoices"

    def __init__(self, plugin: Plugin) -> None:
        self._plugin = plugin

    def save_invoice(self, invoice: HoldInvoice, mode: str = "must-create") -> None:
        self._plugin.rpc.datastore(
            key=[PLUGIN_NAME, DataStore._invoices_key, invoice.payment_hash],
            string=invoice.to_json(),
            mode=mode,
        )

    def list_invoices(self, payment_hash: str | None) -> list[HoldInvoice]:
        key = [PLUGIN_NAME, DataStore._invoices_key]
        if payment_hash is not None:
            key.append(payment_hash)

        return self._parse_invoices(self._plugin.rpc.listdatastore(
            key=key,
        ))

    def get_invoice(self, payment_hash: str) -> HoldInvoice | None:
        invoices = self.list_invoices(payment_hash)
        if len(invoices) == 0:
            return None

        return invoices[0]

    def delete_invoice(self, payment_hash: str) -> bool:
        try:
            self._plugin.rpc.deldatastore(
                [PLUGIN_NAME, DataStore._invoices_key, payment_hash],
            )
        except RpcError as e:
            if e.error["code"] == DataErrorCodes.KeyDoesNotExist:
                return False

            raise

        return True

    def settle_invoice(self, invoice: HoldInvoice, preimage: str) -> None:
        # TODO: save in the normal invoice table of CLN
        invoice.payment_preimage = preimage
        settler.settle(invoice)
        self.save_invoice(invoice, mode="must-replace")

    def cancel_invoice(self, invoice: HoldInvoice) -> None:
        settler.cancel(invoice)
        self.save_invoice(invoice, mode="must-replace")

    def delete_invoices(self) -> int:
        key = [PLUGIN_NAME, DataStore._invoices_key]
        invoices = self._plugin.rpc.listdatastore(key=key)["datastore"]
        for invoice in invoices:
            self._plugin.rpc.deldatastore(invoice["key"])

        return len(invoices)

    @staticmethod
    def _parse_invoices(data: dict[str, Any]) -> list[HoldInvoice]:
        invoices = []

        for invoice in data["datastore"]:
            invoices.append(HoldInvoice.from_json(invoice["string"]))

        return invoices


pl = Plugin()

ds = DataStore(pl)
settler = Settler(pl)


@pl.init()
def init(
        options: dict[str, Any],
        configuration: dict[str, Any],
        plugin: Plugin,
        **kwargs: dict[str, Any],
) -> None:
    plugin.log(f"Plugin {PLUGIN_NAME} initialized")


@pl.method("holdinvoice")
def hold_invoice(plugin: Plugin, bolt11: str) -> dict[str, Any]:
    dec = plugin.rpc.decodepay(bolt11)
    payment_hash = dec["payment_hash"]

    if len(plugin.rpc.listinvoices(payment_hash=payment_hash)["invoices"]) > 0:
        return Errors.invoice_exists

    signed = plugin.rpc.call("signinvoice", {
        "invstring": bolt11,
    })["bolt11"]

    try:
        ds.save_invoice(
            HoldInvoice(InvoiceState.Unpaid, signed, payment_hash, None),
        )
        plugin.log(f"Added hold invoice {payment_hash} for {dec['amount_msat']}")
    except RpcError as e:
        if e.error["code"] == DataErrorCodes.KeyExists:
            return Errors.invoice_exists

        raise

    return {
        "bolt11": signed,
    }


@pl.method("listholdinvoices")
def list_hold_invoices(plugin: Plugin, payment_hash: str = "") -> dict[str, Any]:
    invoices = ds.list_invoices(None if payment_hash == "" else payment_hash)
    return {
        "holdinvoices": [i.__dict__ for i in invoices],
    }


@pl.method("settleholdinvoice")
def settle_hold_invoice(plugin: Plugin, payment_preimage: str) -> dict[str, Any]:
    payment_hash = sha256(bytes.fromhex(payment_preimage)).hexdigest()
    invoice = ds.get_invoice(payment_hash)
    if invoice is None:
        return Errors.invoice_not_exists

    try:
        ds.settle_invoice(invoice, payment_preimage)
        plugin.log(f"Settled hold invoice {payment_hash}")
    except HoldInvoiceStateError as e:
        return e.error

    return {}


@pl.method("cancelholdinvoice")
def cancel_hold_invoice(plugin: Plugin, payment_hash: str) -> dict[str, Any]:
    invoice = ds.get_invoice(payment_hash)
    if invoice is None:
        return Errors.invoice_not_exists

    try:
        ds.cancel_invoice(invoice)
        plugin.log(f"Cancelled hold invoice {payment_hash}")
    except HoldInvoiceStateError as e:
        return e.error

    return {}


@pl.method("dev-wipeholdinvoices")
def wipe_hold_invoices(plugin: Plugin, payment_hash: str = "") -> dict[str, Any]:
    if payment_hash == "":
        plugin.log("Deleting all hold invoices", level="warn")
        deleted_count = ds.delete_invoices()
    else:
        if not ds.delete_invoice(payment_hash):
            return Errors.invoice_not_exists

        deleted_count = 1
        plugin.log(f"Deleted hold invoice {payment_hash}", level="warn")

    return {
        "deleted_count": deleted_count,
    }


@pl.async_hook("htlc_accepted")
def on_htlc_accepted(
        onion: dict[str, Any],
        htlc: dict[str, Any],
        request: Request,
        plugin: Plugin,
        **kwargs: dict[str, Any],
) -> None:
    # Ignore forwards
    if "forward_to" in kwargs:
        Settler.continue_callback(request)
        return

    invoice = ds.get_invoice(htlc["payment_hash"])

    # Ignore invoices that aren't hold invoices
    if invoice is None:
        Settler.continue_callback(request)
        return

    # TODO: mpp timeout

    dec = plugin.rpc.decodepay(invoice.bolt11)
    if htlc["cltv_expiry_relative"] < dec["min_final_cltv_expiry"]:
        plugin.log(
            f"Rejected hold invoice {invoice.payment_hash}: CLTV too little "
            f"({htlc['cltv_expiry_relative']} < {dec['min_final_cltv_expiry']})",
            level="warn",
        )
        Settler.fail_callback(request, HtlcFailureMessage.IncorrectPaymentDetails)
        return

    settler.handle_htlc(invoice, dec, int(htlc["amount_msat"]), request)


pl.run()
