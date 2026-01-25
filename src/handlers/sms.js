/**
 * SMS 转发处理器
 */

import { validateTimestamp, extractCode, isVerificationSms } from '../utils/validator.js';
import { sendBarkNotification, buildNotificationContent } from '../utils/bark.js';
import { checkRateLimit } from '../utils/rateLimit.js';

/**
 * 处理 SMS 转发请求
 */
export async function handleSmsForward(request, env, url) {
    const isDebug = url.searchParams.get('debug') === 'true' || env.DEBUG === 'true';

    // 1. Token 鉴权（不易踩坑版）
    const auth = (request.headers.get('Authorization') || '').trim();
    const expected = `Bearer ${env.API_TOKEN}`;

    if (auth !== expected) {
        console.log('Auth failed');
        return jsonResponse({ success: false, message: 'Unauthorized' }, 401);
    }

    // 2. 解析请求体
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResponse({ success: false, message: 'Invalid JSON' }, 400);
    }

    // 🔑 无条件转字符串（兼容 iOS / Webhook / curl）
    const content = String(body?.content ?? '').trim();

    // 🔑 再判断是否为空
    if (!content) {
        return jsonResponse({ success: false, message: 'Missing or invalid content field' }, 400);
    }

    if (content.length > 1000) {
        return jsonResponse({ success: false, message: 'Content too long' }, 400);
    }

    console.log('Received SMS forward request:', {
        device: body.device,
        contentLength: content.length,
        hasCode: !!body.code,
    });

    // 3. 时间戳校验
    const timestampResult = validateTimestamp(body.timestamp);
    if (!timestampResult.valid) {
        return jsonResponse({ success: false, message: timestampResult.error }, 400);
    }

    // 4. 速率限制
    const device = body.device || 'unknown';
    const rateResult = await checkRateLimit(env, device);
    if (!rateResult.allowed) {
        return jsonResponse({ success: false, message: rateResult.error }, 429);
    }

    // 5. 提取验证码
    let code = body.code;
    if (!code) {
        code = extractCode(content);
    }

    // 6. 非验证码短信过滤（可选）
    if (!code && !isVerificationSms(content)) {
        console.log('Skipped: not a verification SMS');
        return jsonResponse({
            success: true,
            message: 'skipped',
            reason: 'not a verification SMS',
        });
    }

    // 7. KV 去重检查
    if (code) {
        const dedupeKey = `sms:${code}`;
        const existing = await env.SMS_CACHE.get(dedupeKey);

        if (existing) {
            console.log(`Duplicate code detected: ${code}`);
            return jsonResponse({
                success: true,
                message: 'skipped',
                reason: 'duplicate',
                code,
            });
        }

        // 写入缓存，TTL 300秒
        await env.SMS_CACHE.put(dedupeKey, JSON.stringify({
            device,
            timestamp: Date.now(),
            content: content.slice(0, 100), // 只存储前100字符
        }), { expirationTtl: 300 });
    }

    // 8. Debug 模式：只写 KV，不推送
    if (isDebug) {
        console.log('Debug mode: skipping Bark push');
        return jsonResponse({
            success: true,
            message: 'debug',
            code,
            note: 'Bark push skipped in debug mode',
        });
    }

    // 9. 发送 Bark 推送
    const { title, body: notifyBody } = buildNotificationContent(code, content, device);

    // 支持指定推送目标
    const targetKeys = body.target && Array.isArray(body.target) ? body.target : null;
    const pushResult = await sendBarkNotification(env, title, notifyBody, targetKeys);

    if (!pushResult.success) {
        console.error('Bark push failed:', pushResult.errors);
        return jsonResponse({
            success: false,
            message: 'Push failed',
            errors: pushResult.errors,
        }, 502);
    }

    console.log(`SMS forwarded successfully: code=${code}, pushed=${pushResult.pushed}`);

    return jsonResponse({
        success: true,
        message: 'forwarded',
        code,
        pushed: pushResult.pushed,
    });
}

/**
 * JSON 响应辅助函数
 */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
