/**
 * SMS 转发处理器
 */

import { validateToken, validateBody, validateTimestamp, extractCode, isVerificationSms } from '../utils/validator.js';
import { sendBarkNotification, buildNotificationContent } from '../utils/bark.js';
import { checkRateLimit } from '../utils/rateLimit.js';

/**
 * 处理 SMS 转发请求
 */
export async function handleSmsForward(request, env, url) {
    const isDebug = url.searchParams.get('debug') === 'true' || env.DEBUG === 'true';

    // 1. Token 鉴权
    const tokenResult = validateToken(request, env);
    if (!tokenResult.valid) {
        console.log('Auth failed:', tokenResult.error);
        return jsonResponse({ success: false, message: 'Unauthorized' }, 401);
    }

    // 2. 解析请求体
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResponse({ success: false, message: 'Invalid JSON' }, 400);
    }

    console.log('Received SMS forward request:', {
        device: body.device,
        contentLength: body.content?.length,
        hasCode: !!body.code,
    });

    // 3. 请求体校验
    const bodyResult = validateBody(body);
    if (!bodyResult.valid) {
        return jsonResponse({ success: false, message: bodyResult.error }, 400);
    }

    // 4. 时间戳校验
    const timestampResult = validateTimestamp(body.timestamp);
    if (!timestampResult.valid) {
        return jsonResponse({ success: false, message: timestampResult.error }, 400);
    }

    // 5. 速率限制
    const device = body.device || 'unknown';
    const rateResult = await checkRateLimit(env, device);
    if (!rateResult.allowed) {
        return jsonResponse({ success: false, message: rateResult.error }, 429);
    }

    // 6. 提取验证码
    let code = body.code;
    if (!code) {
        code = extractCode(body.content);
    }

    // 7. 非验证码短信过滤（可选）
    if (!code && !isVerificationSms(body.content)) {
        console.log('Skipped: not a verification SMS');
        return jsonResponse({
            success: true,
            message: 'skipped',
            reason: 'not a verification SMS',
        });
    }

    // 8. KV 去重检查
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
            content: body.content.slice(0, 100), // 只存储前100字符
        }), { expirationTtl: 300 });
    }

    // 9. Debug 模式：只写 KV，不推送
    if (isDebug) {
        console.log('Debug mode: skipping Bark push');
        return jsonResponse({
            success: true,
            message: 'debug',
            code,
            note: 'Bark push skipped in debug mode',
        });
    }

    // 10. 发送 Bark 推送
    const { title, body: notifyBody } = buildNotificationContent(code, body.content, device);

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
