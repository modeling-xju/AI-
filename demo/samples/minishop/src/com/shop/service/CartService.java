package com.shop.service;

import com.shop.dao.CartDao;
import com.shop.dao.ProductDao;
import com.shop.model.Cart;

/**
 * 购物车业务：加入、修改、移除条目。
 */
public class CartService {

    private CartDao cartDao;
    private ProductDao productDao;

    /** 查看购物车。 */
    public Cart viewCart(long userId) {
        return cartDao.findByUser(userId);
    }

    /** 加入条目，先校验库存。 */
    public void addItem(long userId, long productId, int count) {
        productDao.decreaseStock(productId, count);
        cartDao.insertItem(userId, productId, count);
    }

    /** 修改条目数量。 */
    public void updateItem(long itemId, int count) {
        cartDao.updateCount(itemId, count);
    }

    /** 移除条目。 */
    public void removeItem(long itemId) {
        cartDao.deleteItem(itemId);
    }
}
