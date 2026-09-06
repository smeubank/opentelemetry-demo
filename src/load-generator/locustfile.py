#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

import json
import os
import random
import uuid
import logging

from locust import HttpUser, User, task, between
from locust_plugins.users.playwright import PlaywrightUser, pw, PageWithRetry, event

from opentelemetry import context, baggage, trace
from opentelemetry.context import Context
from opentelemetry.metrics import set_meter_provider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.jinja2 import Jinja2Instrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
from opentelemetry.instrumentation.urllib3 import URLLib3Instrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource

from openfeature import api
from openfeature.contrib.provider.ofrep import OFREPProvider
from openfeature.contrib.hook.opentelemetry import TracingHook

from playwright.async_api import Route, Request

# Configure tracer provider first (needed for trace context in logs)
tracer_provider = TracerProvider()
trace.set_tracer_provider(tracer_provider)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(insecure=True)))

# Configure logger provider with the same resource
logger_provider = LoggerProvider()
set_logger_provider(logger_provider)

# Set up log exporter and processor
log_exporter = OTLPLogExporter(insecure=True)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

# Create logging handler that will include trace context
handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)

# Configure root logger
root_logger = logging.getLogger()
root_logger.addHandler(handler)
root_logger.setLevel(logging.INFO)

# Configure metrics
metric_exporter = OTLPMetricExporter(insecure=True)
set_meter_provider(MeterProvider([PeriodicExportingMetricReader(metric_exporter)]))

# Instrument logging to automatically inject trace context
LoggingInstrumentor().instrument(set_logging_format=True)

# Instrumenting manually to avoid error with locust gevent monkey
Jinja2Instrumentor().instrument()
RequestsInstrumentor().instrument()
SystemMetricsInstrumentor().instrument()
URLLib3Instrumentor().instrument()

logging.info("Instrumentation complete - logs will now include trace context")

# Initialize Flagd provider
base_url = f"http://{os.environ.get('FLAGD_HOST', 'localhost')}:{os.environ.get('FLAGD_OFREP_PORT', 8016)}"
api.set_provider(OFREPProvider(base_url=base_url))
api.add_hooks([TracingHook()])

def get_flagd_value(FlagName):
    # Initialize OpenFeature
    client = api.get_client()
    return client.get_integer_value(FlagName, 0)

categories = [
    "binoculars",
    "telescopes",
    "accessories",
    "assembly",
    "travel",
    "books",
    None,
]

products = [
    "0PUK6V6EV0",
    "1YMWWN1N4O",
    "2ZYFJ3GM2N",
    "66VCHSJNUP",
    "6E92ZMYYFZ",
    "9SIQT8TOJO",
    "L9ECAV7KIM",
    "LS4PSXUNUM",
    "OLJCESPC7Z",
    "HQTGWGPNH4",
]

people_file = open('people.json')
people = json.load(people_file)

class WebsiteUser(HttpUser):
    weight = int(os.environ.get("LOCUST_HTTP_USER_WEIGHT", "9"))
    wait_time = between(1, 10)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.tracer = trace.get_tracer(__name__)

    @task(1)
    def index(self):
        with self.tracer.start_as_current_span("user_index", context=context.get_current()):
            logging.info("User accessing index page")
            self.client.get("/")

    @task(10)
    def browse_product(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_browse_product", context=context.get_current(), attributes={"demo.product.id": product}):
            logging.info(f"User browsing product: {product}")
            self.client.get("/api/products/" + product)

    @task(3)
    def get_recommendations(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_get_recommendations", context=context.get_current(), attributes={"demo.product.id": product}):
            logging.info(f"User getting recommendations for product: {product}")
            params = {
                "productIds": [product],
            }
            self.client.get("/api/recommendations", params=params)

    @task(3)
    def get_ads(self):
        category = random.choice(categories)
        with self.tracer.start_as_current_span("user_get_ads", context=context.get_current(), attributes={"demo.ad.category": str(category)}):
            logging.info(f"User getting ads for category: {category}")
            params = {
                "contextKeys": [category],
            }
            self.client.get("/api/data/", params=params)

    @task(3)
    def view_cart(self):
        with self.tracer.start_as_current_span("user_view_cart", context=context.get_current()):
            logging.info("User viewing cart")
            self.client.get("/api/cart")

    @task(2)
    def add_to_cart(self, user=""):
        if user == "":
            user = str(uuid.uuid1())
        product = random.choice(products)
        quantity = random.choice([1, 2, 3, 4, 5, 10])
        with self.tracer.start_as_current_span("user_add_to_cart", context=context.get_current(), attributes={"user.id": user, "demo.product.id": product, "demo.product.quantity": quantity}):
            logging.info(f"User {user} adding {quantity} of product {product} to cart")
            self.client.get("/api/products/" + product)
            cart_item = {
                "item": {
                    "productId": product,
                    "quantity": quantity,
                },
                "userId": user,
            }
            self.client.post("/api/cart", json=cart_item)

    @task(1)
    def checkout(self):
        user = str(uuid.uuid1())
        with self.tracer.start_as_current_span("user_checkout_single", context=context.get_current(), attributes={"user.id": user}):
            self.add_to_cart(user=user)
            checkout_person = random.choice(people)
            checkout_person["userId"] = user
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Checkout completed for user {user}")

    @task(1)
    def checkout_multi(self):
        user = str(uuid.uuid1())
        item_count = random.choice([2, 3, 4])
        with self.tracer.start_as_current_span("user_checkout_multi", context=context.get_current(),
                                            attributes={"user.id": user, "demo.cart.items.count": item_count}):
            for i in range(item_count):
                self.add_to_cart(user=user)
            checkout_person = random.choice(people)
            checkout_person["userId"] = user
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Multi-item checkout completed for user {user}")

    @task(5)
    def flood_home(self):
        flood_count = get_flagd_value("loadGeneratorFloodHomepage")
        if flood_count > 0:
            with self.tracer.start_as_current_span("user_flood_home",  context=context.get_current(), attributes={"demo.request.flood.count": flood_count}):
                logging.info(f"User flooding homepage {flood_count} times")
                for _ in range(0, flood_count):
                    self.client.get("/")

    def on_start(self):
        session_id = str(uuid.uuid4())
        logging.info(f"Starting user session: {session_id}")
        # Attach the baggage-bearing context OUTSIDE of any span's `with` block.
        # If this were attached *inside* start_as_current_span(...)'s `with` block,
        # that block's own exit would detach past this manual attach and silently
        # discard the baggage for the rest of the user's session.
        ctx = baggage.set_baggage("session.id", session_id)
        ctx = baggage.set_baggage("synthetic_request", "true", context=ctx)
        context.attach(ctx)
        with self.tracer.start_as_current_span("user_session_start", context=context.get_current()):
            self.index()


browser_traffic_enabled = os.environ.get("LOCUST_BROWSER_TRAFFIC_ENABLED", "").lower() in ("true", "yes", "on")

if browser_traffic_enabled:
    class WebsiteBrowserUser(PlaywrightUser):
        weight = int(os.environ.get("LOCUST_BROWSER_USER_WEIGHT", "1"))
        headless = True  # to use a headless browser, without a GUI

        @task
        @pw
        async def open_cart_page_and_change_currency(self, page: PageWithRetry):
            tracer = trace.get_tracer(__name__)
            with tracer.start_as_current_span("browser_change_currency", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    await page.goto("/cart", wait_until="domcontentloaded")
                    await page.select_option('[name="currency_code"]', 'CHF')
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Currency changed to CHF")
                except Exception as e:
                    logging.error(f"Error in change currency task: {str(e)}")

        @task
        @pw
        async def add_product_to_cart(self, page: PageWithRetry):
            tracer = trace.get_tracer(__name__)
            with tracer.start_as_current_span("browser_add_to_cart", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    # Wait for Roof Binoculars image to load (awaiting successful XHR response in less than 15 seconds)
                    async with page.expect_event(
                        "response",
                        predicate=lambda r: '/images/products/RoofBinoculars.jpg' in r.url and r.status == 200,
                        timeout=15000
                    ):
                        await page.goto("/", wait_until="domcontentloaded")
                    await page.click('p:has-text("Roof Binoculars")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.click('button:has-text("Add To Cart")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Product added to cart successfully")
                except Exception as e:
                    logging.error(f"Error in add to cart task: {str(e)}")

async def add_baggage_header(route: Route, request: Request):
    existing_baggage = request.headers.get('baggage', '')
    headers = {
        **request.headers,
        'baggage': ', '.join(filter(None, (existing_baggage, 'synthetic_request=true')))
    }
    await route.continue_(headers=headers)


# Opt-in: only spawned when a Supabase session-pooler URL is provided. Holds idle
# Postgres connections to exhaust the project's connection limit on demand, driven by
# the `supabaseConnectionExhaustion` flag, so the Supabase `db_connection_limit_reached`
# health check fires while the shop UI visibly errors.
database_exhaustion_url = os.environ.get("SUPABASE_DB_URL_SESSION", "").strip()

if database_exhaustion_url:
    import psycopg
    import re
    import requests as _requests

    # When a Management API token is provided, the exhaustion user raises the pooler's
    # default_pool_size above Postgres max_connections so held session clients actually exhaust
    # the DATABASE (not just the pooler's small client cap), then reverts it when the flag is off.
    # This makes the cascade fully flag-driven — no manual pool reconfiguration. Opt-in via
    # SUPABASE_ACCESS_TOKEN; without it, exhaustion is capped at the pooler client limit (~15).
    _mgmt_token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    _ref_match = re.search(r"https://([a-z0-9]+)\.supabase\.", os.environ.get("SUPABASE_URL", ""))
    _project_ref = _ref_match.group(1) if _ref_match else ""
    _POOL_EXHAUST_SIZE = 90   # above max_connections (60) so real backends run out
    _POOL_DEFAULT_SIZE = 15   # Supavisor default, restored when the flag goes off

    class DatabaseExhaustionUser(User):
        fixed_count = 1  # a single greenlet reconciles the whole connection pool
        wait_time = between(2, 5)

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.tracer = trace.get_tracer(__name__)
            self.held = []
            self.pool_raised = False

        def _set_pool_size(self, size):
            if not (_mgmt_token and _project_ref):
                return False  # auto-raise disabled -> pooler client cap (~15) applies
            try:
                r = _requests.patch(
                    f"https://api.supabase.com/v1/projects/{_project_ref}/config/database/pooler",
                    headers={"Authorization": f"Bearer {_mgmt_token}", "Content-Type": "application/json"},
                    json={"default_pool_size": size}, timeout=15)
                logging.info(f"pooler default_pool_size -> {size} (HTTP {r.status_code})")
                return r.status_code < 300
            except Exception as e:
                logging.warning(f"failed to set pooler pool size: {e}")
                return False

        def _open_one(self):
            with self.tracer.start_as_current_span("db_hold_connection") as span:
                try:
                    conn = psycopg.connect(database_exhaustion_url, autocommit=True, connect_timeout=5)
                    conn.execute("SELECT 1")
                    self.held.append(conn)
                    span.set_attribute("demo.db.held_connections", len(self.held))
                    return True
                except psycopg.OperationalError as e:
                    sqlstate = getattr(e, "sqlstate", None)
                    message = str(e)
                    span.set_attribute("demo.db.connection_error", message)
                    # SQLSTATE 53300 = too_many_connections; the pooler may instead surface a
                    # "too many"/"max clients" message, so match on both.
                    if sqlstate == "53300" or "too many" in message.lower() or "max client" in message.lower():
                        span.set_attribute("demo.db.connection_limit_reached", True)
                        logging.error(f"Supabase connection limit reached while holding {len(self.held)} connections: {message}")
                    else:
                        logging.error(f"Failed to open Supabase connection: {message}")
                    return False

        def _release_one(self):
            conn = self.held.pop()
            try:
                conn.close()
            except Exception as e:
                logging.warning(f"Error closing held connection: {e}")

        def _release_all(self):
            while self.held:
                self._release_one()

        @task
        def reconcile_connections(self):
            target = get_flagd_value("supabaseConnectionExhaustion")
            # Raise the pooler pool above max_connections while exhausting, revert when off.
            if target > 0 and not self.pool_raised:
                if self._set_pool_size(_POOL_EXHAUST_SIZE):
                    self.pool_raised = True
            elif target == 0 and self.pool_raised:
                self._set_pool_size(_POOL_DEFAULT_SIZE)
                self.pool_raised = False
            with self.tracer.start_as_current_span(
                "db_exhaustion_reconcile",
                context=context.get_current(),
                attributes={"demo.db.target_connections": target, "demo.db.held_connections": len(self.held)},
            ):
                while len(self.held) > target:
                    self._release_one()
                while len(self.held) < target:
                    if not self._open_one():
                        break
                logging.info(f"Holding {len(self.held)}/{target} Supabase connections")

        def on_stop(self):
            self._release_all()
            if self.pool_raised:
                self._set_pool_size(_POOL_DEFAULT_SIZE)
                self.pool_raised = False


# Opt-in: only spawned when Supabase HTTP creds are provided. Sends error-inducing requests to a
# chosen Supabase service so its log_*_error_rate_high health check fires. The service is selected
# by the supabaseServiceErrors flag (off/auth/storage/edge_function/all).
supabase_http_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
supabase_apikey = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()

if supabase_http_url and supabase_apikey:
    import requests

    _SERVICE_BY_FLAG = {2: "auth", 3: "storage", 4: "edge_function", 5: "all"}
    _ALL_SERVICES = ["auth", "storage", "edge_function"]

    class SupabaseServiceErrorUser(User):
        fixed_count = 2  # a couple of greenlets are enough to clear the >=50 req / 5-min window
        wait_time = between(1, 2)

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.tracer = trace.get_tracer(__name__)
            self.session = requests.Session()
            self.session.headers.update({"apikey": supabase_apikey, "Authorization": f"Bearer {supabase_apikey}"})

        def _hit(self, service):
            # Each request is expected to produce a 5xx from the named Supabase service.
            if service == "edge_function":
                # Drives volume against the real payment-charge edge function so its
                # log_edge_function_error_rate_high check fires; injectFailure forces a 500.
                return self.session.post(f"{supabase_http_url}/functions/v1/payment-charge", json={"injectFailure": True}, timeout=10)
            if service == "auth":
                # best-effort: auth usually returns 4xx (not counted as 5xx) — see supademo-readme.md
                return self.session.post(f"{supabase_http_url}/auth/v1/token?grant_type=password", json={"email": "x@x", "password": "x"}, timeout=10)
            if service == "storage":
                # best-effort: storage usually returns 4xx (not counted as 5xx) — see supademo-readme.md
                return self.session.get(f"{supabase_http_url}/storage/v1/object/authenticated/nonexistent/nonexistent.txt", timeout=10)
            return None

        @task
        def drive_errors(self):
            selected = _SERVICE_BY_FLAG.get(get_flagd_value("supabaseServiceErrors"))
            if not selected:
                return
            services = _ALL_SERVICES if selected == "all" else [selected]
            for service in services:
                with self.tracer.start_as_current_span("supabase_service_error", context=context.get_current(), attributes={"demo.supabase.service": service}):
                    statuses = []
                    for _ in range(3):
                        try:
                            r = self._hit(service)
                            statuses.append(r.status_code if r is not None else 0)
                        except Exception as e:
                            statuses.append(-1)
                            logging.warning(f"supabase {service} request error: {e}")
                    logging.info(f"supabase {service} error-load statuses: {statuses}")
