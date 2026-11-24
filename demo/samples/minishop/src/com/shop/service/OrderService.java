package com.shop.service;

import com.shop.dao.OrderDao;
import com.shop.model.Order;
import com.shop.util.MoneyUtil;

/**
 * 订单业务：创建订单、标记支付、取消订单。
 */
public class OrderService {

    private OrderDao orderDao;
    private PaymentService paymentService;

    /** 创建订单并写入数据库。 */
    public long createOrder(Order order) {
        long total = MoneyUtil.sum(order.getLines());
        order.setTotal(total);
        return orderDao.insert(order);
    }

    /** 标记订单已支付。 */
    public void markPaid(long orderId) {
        paymentService.charge(orderId);
        orderDao.updateStatus(orderId, "PAID");
    }

    /** 取消订单。 */
    public void cancelOrder(long orderId) {
        orderDao.updateStatus(orderId, "CANCELED");
    }

    /** 按编号查询订单。 */
    public Order findOrder(long orderId) {
        return orderDao.findById(orderId);
    }
}
