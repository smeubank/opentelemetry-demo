/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package frauddetection

import com.google.gson.JsonParser
import com.google.protobuf.util.JsonFormat
import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.TextMapGetter
import oteldemo.Demo.OrderResult
import org.apache.logging.log4j.LogManager
import org.apache.logging.log4j.Logger
import java.sql.Connection
import java.sql.DriverManager

private val pgmqLogger: Logger = LogManager.getLogger("$groupID.pgmq")

private const val PGMQ_QUEUE = "orders_fraud"
private const val PGMQ_VISIBILITY_TIMEOUT_SECONDS = 30
private const val PGMQ_READ_BATCH = 10

// Reads the W3C traceparent out of the JSON envelope map.
private val ENVELOPE_GETTER = object : TextMapGetter<Map<String, String>> {
    override fun keys(carrier: Map<String, String>): Iterable<String> = carrier.keys
    override fun get(carrier: Map<String, String>?, key: String): String? = carrier?.get(key)
}

/**
 * Starts the opt-in Supabase Queues (pgmq) poller on a daemon thread when
 * QUEUE_PGMQ_ENABLED is truthy and FRAUD_PGMQ_JDBC_URL is set. It runs alongside the
 * Kafka consumer; the checkout producer decides which backend each order lands on via
 * the supabaseOrderQueueBackend flag. Unlike Kafka, pgmq has no messaging
 * auto-instrumentation, so the consumer span and trace propagation are hand-written;
 * the read/delete SQL still gets db spans for free from the agent's JDBC instrumentation.
 */
fun startPgmqPoller() {
    val jdbcUrl = System.getenv("FRAUD_PGMQ_JDBC_URL")
    val flag = System.getenv("QUEUE_PGMQ_ENABLED")?.lowercase()
    if (jdbcUrl == null || (flag != "true" && flag != "1")) {
        return
    }

    Thread {
        pgmqLoop(jdbcUrl)
    }.apply {
        isDaemon = true
        name = "pgmq-poller"
        start()
    }
    pgmqLogger.info("Started Supabase Queues (pgmq) poller for queue $PGMQ_QUEUE")
}

private fun pgmqLoop(jdbcUrl: String) {
    var totalCount = 0L
    while (true) {
        try {
            DriverManager.getConnection(jdbcUrl).use { conn ->
                while (true) {
                    val messages = pgmqRead(conn)
                    if (messages.isEmpty()) {
                        Thread.sleep(500)
                        continue
                    }
                    for ((msgId, text) in messages) {
                        totalCount = processMessage(conn, msgId, text, totalCount)
                    }
                }
            }
        } catch (e: Exception) {
            pgmqLogger.error("pgmq poll error, reconnecting", e)
            Thread.sleep(1000)
        }
    }
}

private fun pgmqRead(conn: Connection): List<Pair<Long, String>> {
    val messages = mutableListOf<Pair<Long, String>>()
    conn.prepareStatement("SELECT msg_id, message::text FROM pgmq.read(?, ?, ?)").use { stmt ->
        stmt.setString(1, PGMQ_QUEUE)
        stmt.setInt(2, PGMQ_VISIBILITY_TIMEOUT_SECONDS)
        stmt.setInt(3, PGMQ_READ_BATCH)
        stmt.executeQuery().use { rs ->
            while (rs.next()) {
                messages.add(rs.getLong(1) to rs.getString(2))
            }
        }
    }
    return messages
}

private fun pgmqDelete(conn: Connection, msgId: Long) {
    conn.prepareStatement("SELECT pgmq.delete(?, ?)").use { stmt ->
        stmt.setString(1, PGMQ_QUEUE)
        stmt.setLong(2, msgId)
        stmt.execute()
    }
}

private fun processMessage(conn: Connection, msgId: Long, text: String, previousCount: Long): Long {
    val root = JsonParser.parseString(text).asJsonObject
    val traceparent = root.get("traceparent")?.takeUnless { it.isJsonNull }?.asString
    val carrier = if (traceparent != null) mapOf("traceparent" to traceparent) else emptyMap()

    val propagator = GlobalOpenTelemetry.getPropagators().textMapPropagator
    val parentContext = propagator.extract(Context.current(), carrier, ENVELOPE_GETTER)

    val tracer = GlobalOpenTelemetry.getTracer(groupID)
    val span = tracer.spanBuilder("$PGMQ_QUEUE process")
        .setSpanKind(SpanKind.CONSUMER)
        .setParent(parentContext)
        .setAttribute("messaging.system", "pgmq")
        .setAttribute("messaging.operation", "receive")
        .setAttribute("messaging.destination.name", PGMQ_QUEUE)
        .setAttribute("demo.queue.backend", "pgmq")
        .setAttribute("demo.queue.name", PGMQ_QUEUE)
        .startSpan()

    val newCount = previousCount + 1
    try {
        span.makeCurrent().use {
            if (getFeatureFlagValue("kafkaQueueProblems") > 0) {
                pgmqLogger.info("FeatureFlag 'kafkaQueueProblems' is enabled, sleeping 1 second")
                Thread.sleep(1000)
            }
            val orderBuilder = OrderResult.newBuilder()
            JsonFormat.parser().ignoringUnknownFields()
                .merge(root.getAsJsonObject("order").toString(), orderBuilder)
            val order = orderBuilder.build()
            pgmqLogger.info("Consumed pgmq record with orderId: ${order.orderId}, and updated total count to: $newCount")
            // Delete inside the span so the db span nests under the consumer span.
            pgmqDelete(conn, msgId)
        }
    } finally {
        span.end()
    }
    return newCount
}
