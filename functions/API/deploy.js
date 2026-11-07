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

export async function onRequestPost({ request, env }) {
    try {
        if (
            !env.LAYERBASE_API_URL ||
            !env.LAYERBASE_API_KEY ||
            !env.LAYERBASE_DATABASE_ID ||
            !env.WHOP_API_KEY ||
            !env.WHOP_COMPANY_ID ||
            !env.WHOP_PLAN_ID
        ) {
            return json({
                success: false,
                error: "The server is not configured yet."
            }, 500);
        }

        const body = await request.json();
        const pageId = String(body.pageId || "");

        if (!validUUID(pageId)) {
            return json({
                success: false,
                error: "Invalid page ID."
            }, 400);
        }

        const result = await database(env, `
            SELECT page_id, status, checkout_id
            FROM pages
            WHERE page_id = ${sql(pageId)}
            LIMIT 1
        `);

        const page = result.rows?.[0];

        if (!page) {
            return json({
                success: false,
                error: "Website not found."
            }, 404);
        }

        if (page[1] !== "preview") {
            return json({
                success: false,
                error: "This website is not available for deployment."
            }, 409);
        }

        if (page[2]) {
            return json({
                success: false,
                error: "A checkout has already been created for this website."
            }, 409);
        }

        const origin = new URL(request.url).origin;

        const checkoutResponse = await fetch(
            "https://api.whop.com/api/v1/checkout_configurations",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${env.WHOP_API_KEY}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Idempotency-Key": `mypage-${pageId}`,
                    "Api-Version-Date": "2026-11-05-1"
                },
                body: JSON.stringify({
                    account_id: env.WHOP_COMPANY_ID,
                    variant_id: env.WHOP_PLAN_ID,
                    metadata: {
                        page_id: pageId,
                        service: "mypage_hosting"
                    },
                    redirect_url: `${origin}/?payment=complete`
                })
            }
        );

        const checkout = await checkoutResponse.json().catch(() => ({}));

        if (!checkoutResponse.ok) {
            console.error("Whop checkout error:", checkout);

            return json({
                success: false,
                error: "Could not create the payment checkout."
            }, 502);
        }

        const checkoutUrl = checkout.purchase_url;

        if (
            !checkoutUrl ||
            !checkoutUrl.startsWith("https://whop.com/")
        ) {
            return json({
                success: false,
                error: "Whop returned an invalid checkout URL."
            }, 502);
        }

        await database(env, `
            UPDATE pages
            SET checkout_id = ${sql(checkout.id)},
                updated_at = CURRENT_TIMESTAMP
            WHERE page_id = ${sql(pageId)}
              AND status = 'preview'
        `);

        return json({
            success: true,
            checkoutUrl
        });

    } catch (error) {
        console.error("Deploy error:", error);

        return json({
            success: false,
            error: "We could not prepare deployment. Please try again."
        }, 500);
    }
}
