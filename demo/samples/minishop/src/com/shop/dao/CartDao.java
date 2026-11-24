package com.shop.dao;

import com.shop.model.Cart;
import com.shop.model.CartItem;
import java.util.ArrayList;
import java.util.List;

/**
 * 购物车数据访问。
 */
public class CartDao {

    private List<CartItem> items = new ArrayList<>();
    private long seq = 0;

    /** 按用户查询购物车。 */
    public Cart findByUser(long userId) {
        Cart cart = new Cart();
        cart.setUserId(userId);
        for (CartItem item : itemsOf(userId)) {
            cart.addItem(item);
        }
        return cart;
    }

    /** 新增购物车条目。 */
    public void insertItem(long userId, long productId, int count) {
        seq = seq + 1;
        CartItem item = new CartItem();
        item.setId(seq);
        item.setUserId(userId);
        item.setProductId(productId);
        item.setCount(count);
        items.add(item);
    }

    /** 修改条目数量。 */
    public void updateCount(long itemId, int count) {
        for (CartItem item : items) {
            if (item.getId() == itemId) {
                item.setCount(count);
            }
        }
    }

    /** 删除条目。 */
    public void deleteItem(long itemId) {
        items.removeIf(item -> item.getId() == itemId);
    }

    /** 查询用户的所有条目。 */
    public List<CartItem> itemsOf(long userId) {
        List<CartItem> result = new ArrayList<>();
        for (CartItem item : items) {
            if (item.getUserId() == userId) {
                result.add(item);
            }
        }
        return result;
    }
}
