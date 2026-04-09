# Goal

清理数据库中已废弃的会员/支付相关字段和表。

## 背景

已移除 free/plus 会员体系、alipay 支付、task 数量限制等功能，运行时不再读取这些字段，但 Prisma schema 和数据库中仍保留着。

## 范围

1. `User` 表：移除 `subscriptionStatus`、`subscriptionTier`、`trialEndsAt`、`subscriptionEndsAt`、`lastPaymentAt` 字段
2. `Order` 表：评估是否整表删除（如无历史订单需要保留）
3. 清理 `web/src/lib/subscription/service.ts` 中不再需要的函数（`startFreeTrial`、`activatePlusSubscription`、`renewPlusSubscription`、`checkAndUpdateExpiredSubscription` 等）
4. 清理 `web/src/app/api/payment/` 和 `web/src/app/api/subscription/create-payment/` 路由
5. 清理 `web/src/app/(main)/subscription/page.tsx` 订阅页面
6. 清理 `web/src/lib/payment/alipay.ts` 和 `web/src/lib/payment/stripe.ts`
7. 移除 `alipay-sdk` 等不再需要的依赖

## 注意事项

- 需要写 Prisma migration
- 部署前确认线上无依赖这些字段的查询
