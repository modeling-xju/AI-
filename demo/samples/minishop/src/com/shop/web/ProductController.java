package com.shop.web;

import com.shop.model.Product;
import com.shop.model.ProductPage;
import com.shop.service.ProductService;

/**
 * 商品接口：列表、详情、库存。
 */
public class ProductController {

    private ProductService productService;

    /** 分页列出在售商品。 */
    public ProductPage list(int page, int size) {
        return productService.listOnSale(page, size);
    }

    /** 查看商品详情。 */
    public Product detail(long id) {
        return productService.findProduct(id);
    }

    /** 查询商品库存。 */
    public int stock(long id) {
        return productService.queryStock(id);
    }
}
