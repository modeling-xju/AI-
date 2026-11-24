package com.shop.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 商品分页结果。
 */
public class ProductPage {

    private List<Product> items = new ArrayList<>();
    private int total;

    public List<Product> getItems() {
        return items;
    }

    public void setItems(List<Product> items) {
        this.items = items;
    }

    public int getTotal() {
        return total;
    }

    public void setTotal(int total) {
        this.total = total;
    }
}
