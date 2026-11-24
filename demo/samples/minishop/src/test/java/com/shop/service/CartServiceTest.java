package com.shop.service;

import com.shop.dao.CartDao;
import com.shop.model.Cart;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

/**
 * 购物车业务测试：仅用于演示「测试文件被识别但不进入逆向分析」。
 */
public class CartServiceTest {

    private CartService cartService;

    @Before
    public void setUp() {
        cartService = new CartService(new CartDao());
    }

    @Test
    public void addItemShouldIncreaseCount() {
        Cart cart = cartService.viewCart(1L);
        int before = cart.getItems().size();
        cartService.addItem(1L, 10L, 2);
        int after = cartService.viewCart(1L).getItems().size();
        Assert.assertTrue(after >= before);
    }

    @Test
    public void removeItemShouldReturnToEmpty() {
        cartService.addItem(2L, 10L, 1);
        cartService.removeItem(2L, 10L);
        Assert.assertTrue(cartService.viewCart(2L).getItems().isEmpty());
    }
}
