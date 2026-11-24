package com.shop.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 订单：编号、状态、金额与明细。
 */
public class Order {

    private long id;
    private String status;
    private long total;
    private List<OrderLine> lines = new ArrayList<>();

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public long getTotal() {
        return total;
    }

    public void setTotal(long total) {
        this.total = total;
    }

    public List<OrderLine> getLines() {
        return lines;
    }
}
