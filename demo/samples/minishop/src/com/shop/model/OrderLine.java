package com.shop.model;

/**
 * 订单明细：一个商品与它的数量。
 */
public class OrderLine {

    private long productId;
    private int count;
    private long price;

    public long getProductId() {
        return productId;
    }

    public void setProductId(long productId) {
        this.productId = productId;
    }

    public int getCount() {
        return count;
    }

    public void setCount(int count) {
        this.count = count;
    }

    public long getPrice() {
        return price;
    }

    public void setPrice(long price) {
        this.price = price;
    }
}
