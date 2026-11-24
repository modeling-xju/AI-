package com.shop.dao;

import com.shop.model.Order;
import java.util.ArrayList;
import java.util.List;

/**
 * 订单数据访问：内存表的增删改查。
 */
public class OrderDao {

    private List<Order> orders = new ArrayList<>();
    private long seq = 0;

    /** 插入订单并返回编号。 */
    public long insert(Order order) {
        seq = seq + 1;
        order.setId(seq);
        orders.add(order);
        return seq;
    }

    /** 更新订单状态。 */
    public void updateStatus(long orderId, String status) {
        Order found = findById(orderId);
        if (found != null) {
            found.setStatus(status);
        }
    }

    /** 按编号查找订单。 */
    public Order findById(long orderId) {
        for (Order order : orders) {
            if (order.getId() == orderId) {
                return order;
            }
        }
        return null;
    }
}
