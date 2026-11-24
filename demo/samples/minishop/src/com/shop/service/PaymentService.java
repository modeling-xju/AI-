package com.shop.service;

import com.shop.dao.OrderDao;

/**
 * 支付业务：扣款与回写支付状态。
 */
public class PaymentService {

    private OrderDao orderDao;

    /** 对订单发起扣款。 */
    public void charge(long orderId) {
        orderDao.updateStatus(orderId, "CHARGING");
        orderDao.updateStatus(orderId, "PAID");
    }
}
