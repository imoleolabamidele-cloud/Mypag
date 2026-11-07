function sql(value) {
    return "'" + String(value)
        .replace(/\0/g, "")
        .replace(/'/g, "''") + "'";
}

function validUUID(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function htmlResponse(content, status = 200) {
    return new Response(content, {
        status,
        headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": [
                "default-src 'none'",
                "style-src 'unsafe-inline'",
                "script-src 'unsafe-inline'",
                "img-src data:",
                "font-src data:",
                "connect-src 'none'",
                "form-action 'none'",
                "base-uri 'none'",
                "frame-ancestors 'none'",
                "sandbox allow-scripts"
            ].join("; ")
        }
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

function getRows(result) {
    if (Array.isArray(result?.rows)) {
        return result.rows;
    }

    if (Array.isArray(result?.data)) {
        return result.data;
    }

    if (Array.isArray(result)) {
        return result;
    }

    return [];
}

export async function onRequestGet({ request, env }) {
    try {
        if (
            !env.LAYERBASE_API_URL ||
            !env.LAYERBASE_API_KEY ||
            !env.LAYERBASE_DATABASE_ID
        ) {
            return htmlResponse("Server configuration error.", 500);
        }

        const url = new URL(request.url);

        const pageId = url.searchParams.get("id");
        const mode = url.searchParams.get("mode") || "live";

        if (!validUUID(pageId || "")) {
            return htmlResponse("Invalid website address.", 400);
        }

        if (!["preview", "live"].includes(mode)) {
            return htmlResponse("Invalid website mode.", 400);
        }

        const result = await database(env, `
            SELECT html_content, status
            FROM pages
            WHERE page_id = ${sql(pageId)}
            LIMIT 1
        `);

        const rows = getRows(result);
        const row = rows[0];

        if (!row) {
            return htmlResponse("Website not found.", 404);
        }

        const html = Array.isArray(row)
            ? row[0]
            : row.html_content;

        const status = Array.isArray(row)
            ? row[1]
            : row.status;

        if (mode === "preview" && status !== "preview") {
            return htmlResponse("Preview unavailable.", 404);
        }

        if (mode === "live" && status !== "live") {
            return htmlResponse("This website is not published.", 404);
        }

        if (
            typeof html !== "string" ||
            !html.trim() ||
            html.length > 250000
        ) {
            return htmlResponse("Website content is invalid.", 500);
        }

        return htmlResponse(html);

    } catch (error) {
        console.error("Pages error:", error);

        return htmlResponse(
            "We could not load this website. Please try again.",
            500
        );
    }
}