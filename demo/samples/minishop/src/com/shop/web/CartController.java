package com.shop.web;

import com.shop.model.Cart;
import com.shop.service.CartService;

/**
 * 购物车接口：查看、加入、修改数量、移除。
 */
public class CartController {

    private CartService cartService;

    /** 查看当前用户的购物车。 */
    public Cart listCart(long userId) {
        return cartService.viewCart(userId);
    }

    /** 把商品加入购物车。 */
    public String addToCart(long userId, long productId, int count) {
        cartService.addItem(userId, productId, count);
        return "ok";
    }

    /** 修改购物车条目的数量。 */
    public String updateCount(long itemId, int count) {
        cartService.updateItem(itemId, count);
        return "ok";
    }

    /** 从购物车移除条目。 */
    public String removeItem(long itemId) {
        cartService.removeItem(itemId);
        return "ok";
    }
}
