package com.shop.dao;

import com.shop.model.Product;
import java.util.ArrayList;
import java.util.List;

/**
 * 商品数据访问。
 */
public class ProductDao {

    private List<Product> products = new ArrayList<>();

    /** 按编号查询商品。 */
    public Product findById(long id) {
        for (Product product : products) {
            if (product.getId() == id) {
                return product;
            }
        }
        return null;
    }

    /** 分页查询在售商品。 */
    public List<Product> findOnSale(int page, int size) {
        List<Product> result = new ArrayList<>();
        int start = page * size;
        for (int index = 0; index < products.size(); index++) {
            if (index >= start && result.size() < size) {
                result.add(products.get(index));
            }
        }
        return result;
    }

    /** 统计在售商品数量。 */
    public int countOnSale() {
        return products.size();
    }

    /** 查询库存数量。 */
    public int stockOf(long id) {
        Product found = findById(id);
        return found == null ? 0 : found.getStock();
    }

    /** 扣减库存。 */
    public void decreaseStock(long id, int count) {
        Product found = findById(id);
        if (found != null) {
            found.setStock(found.getStock() - count);
        }
    }

    /** 增加库存。 */
    public void increaseStock(long id, int count) {
        Product found = findById(id);
        if (found != null) {
            found.setStock(found.getStock() + count);
        }
    }
}
