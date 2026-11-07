function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        }
    });
}

function sql(value) {
    return "'" + String(value)
        .replace(/\0/g, "")
        .replace(/'/g, "''") + "'";
}

function validUUID(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

async function verifyWebhook(request, rawBody, secret) {
    const id = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");
    const signatures = request.headers.get("webhook-signature");

    if (!id || !timestamp || !signatures || !secret) {
        return false;
    }

    const timestampNumber = Number(timestamp);

    if (
        !Number.isFinite(timestampNumber) ||
        Math.abs(Date.now() / 1000 - timestampNumber) > 300
    ) {
        return false;
    }

    if (!secret.startsWith("whsec_")) {
        return false;
    }

    let secretBytes;

    try {
        secretBytes = base64ToBytes(secret.slice(6));
    } catch {
        return false;
    }

    const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signedContent = `${id}.${timestamp}.${rawBody}`;

    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(signedContent)
    );

    const expected = bytesToBase64(new Uint8Array(signature));

    return signatures.split(" ").some(item => {
        const parts = item.split(",");

        return (
            parts.length === 2 &&
            parts[0] === "v1" &&
            parts[1] === expected
        );
    });
}

async function database(env, query) {
    const response = await fetch(
        `${env.LAYERBASE_API_URL}/v1/databases/${env.LAYERBASE_DATABASE_ID}/query`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.LAYERBASE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ query })
        }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(result.error || "Database request failed.");
    }

    return result;
}

function getEventPageId(data) {
    const pageId =
        data?.metadata?.page_id ||
        data?.payment?.metadata?.page_id ||
        data?.membership?.metadata?.page_id;

    return typeof pageId === "string" && validUUID(pageId)
        ? pageId
        : null;
}

function getEventPlanId(data) {
    return (
        data?.plan?.id ||
        data?.plan_id ||
        data?.payment?.plan?.id ||
        data?.membership?.plan?.id ||
        null
    );
}

export async function onRequestPost({ request, env }) {
    try {
        if (
            !env.WHOP_WEBHOOK_SECRET ||
            !env.WHOP_PLAN_ID ||
            !env.LAYERBASE_API_URL ||
            !env.LAYERBASE_API_KEY ||
            !env.LAYERBASE_DATABASE_ID
        ) {
            return json({
                success: false,
                error: "Webhook configuration is incomplete."
            }, 500);
        }

        const rawBody = await request.text();

        const verified = await verifyWebhook(
            request,
            rawBody,
            env.WHOP_WEBHOOK_SECRET
        );

        if (!verified) {
            return json({
                success: false,
                error: "Invalid webhook signature."
            }, 401);
        }

        const event = JSON.parse(rawBody);

        if (!event || typeof event.type !== "string") {
            return json({
                success: false,
                error: "Invalid webhook event."
            }, 400);
        }

        const data = event.data || {};
        const pageId = getEventPageId(data);

        const supportedEvents = [
            "payment.succeeded",
            "payment.failed",
            "membership.deactivated"
        ];

        if (!supportedEvents.includes(event.type)) {
            return json({ success: true, ignored: true });
        }

        if (!pageId) {
            return json({
                success: false,
                error: "Missing or invalid page metadata."
            }, 400);
        }

        const planId = getEventPlanId(data);

        if (planId && planId !== env.WHOP_PLAN_ID) {
            return json({
                success: false,
                error: "Unexpected payment plan."
            }, 403);
        }

        if (event.type === "payment.succeeded") {
            await database(env, `
                UPDATE pages
                SET status = 'live',
                    updated_at = CURRENT_TIMESTAMP
                WHERE page_id = ${sql(pageId)}
                  AND status IN ('preview', 'building', 'live')
            `);
        }

        if (event.type === "payment.failed") {
            await database(env, `
                DELETE FROM pages
                WHERE page_id = ${sql(pageId)}
            `);
        }

        if (event.type === "membership.deactivated") {
            await database(env, `
                DELETE FROM pages
                WHERE page_id = ${sql(pageId)}
            `);
        }

        return json({
            success: true,
            processed: event.type
        });

    } catch (error) {
        console.error("Whop webhook error:", error);

        return json({
            success: false,
            error: "Webhook processing failed."
        }, 500);
    }
}