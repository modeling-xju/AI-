package com.shop.web;

import com.shop.model.Order;
import com.shop.service.OrderService;

/**
 * 订单接口：提交、支付、取消、查询。
 */
public class OrderController {

    private OrderService orderService;

    /** 提交订单，返回订单编号。 */
    public long submit(Order order) {
        return orderService.createOrder(order);
    }

    /** 支付订单。 */
    public String pay(long id) {
        orderService.markPaid(id);
        return "ok";
    }

    /** 取消订单。 */
    public String cancel(long id) {
        orderService.cancelOrder(id);
        return "ok";
    }

    /** 查看订单详情。 */
    public Order detail(long id) {
        return orderService.findOrder(id);
    }
}
