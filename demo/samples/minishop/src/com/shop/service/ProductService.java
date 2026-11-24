package com.shop.service;

import com.shop.dao.ProductDao;
import com.shop.model.Product;
import com.shop.model.ProductPage;

/**
 * 商品业务：列表、详情、库存查询。
 */
public class ProductService {

    private ProductDao productDao;

    /** 分页列出在售商品。 */
    public ProductPage listOnSale(int page, int size) {
        ProductPage result = new ProductPage();
        result.setItems(productDao.findOnSale(page, size));
        result.setTotal(productDao.countOnSale());
        return result;
    }

    /** 查询商品详情。 */
    public Product findProduct(long id) {
        return productDao.findById(id);
    }

    /** 查询库存数量。 */
    public int queryStock(long id) {
        return productDao.stockOf(id);
    }

    /** 下单前检查库存是否充足。 */
    public void checkStock(long id, int count) {
        int stock = productDao.stockOf(id);
        if (stock < count) {
            throw new IllegalStateException("库存不足");
        }
    }
}
