package com.shop.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 购物车：一个用户的一组条目。
 */
public class Cart {

    private long userId;
    private List<CartItem> items = new ArrayList<>();

    public long getUserId() {
        return userId;
    }

    public void setUserId(long userId) {
        this.userId = userId;
    }

    public List<CartItem> getItems() {
        return items;
    }

    /** 往购物车里放一个条目。 */
    public void addItem(CartItem item) {
        items.add(item);
    }
}
