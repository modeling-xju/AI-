# -*- coding: utf-8 -*-
"""生成示例 Java 工程 demo/samples/minishop（一次性脚本，可重复执行覆盖）。"""
import os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "samples", "minishop", "src", "com", "shop")

FILES = {}

FILES["web/OrderController.java"] = '''package com.shop.web;

import com.shop.model.Order;
import com.shop.service.OrderService;

/**
 * 订单接口：提交、支付、取消、查询。
 */
public class OrderController {

    private OrderService orderService;

    /** 提交订单，返回订单编号。 */
    public long submit(Order order) {
        return orderService.createOrder(order);
    }

    /** 支付订单。 */
    public String pay(long id) {
        orderService.markPaid(id);
        return "ok";
    }

    /** 取消订单。 */
    public String cancel(long id) {
        orderService.cancelOrder(id);
        return "ok";
    }

    /** 查看订单详情。 */
    public Order detail(long id) {
        return orderService.findOrder(id);
    }
}
'''

FILES["web/CartController.java"] = '''package com.shop.web;

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
'''

FILES["web/ProductController.java"] = '''package com.shop.web;

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
'''

FILES["service/OrderService.java"] = '''package com.shop.service;

import com.shop.dao.OrderDao;
import com.shop.model.Order;
import com.shop.util.MoneyUtil;

/**
 * 订单业务：创建订单、标记支付、取消订单。
 */
public class OrderService {

    private OrderDao orderDao;
    private PaymentService paymentService;

    /** 创建订单并写入数据库。 */
    public long createOrder(Order order) {
        long total = MoneyUtil.sum(order.getLines());
        order.setTotal(total);
        return orderDao.insert(order);
    }

    /** 标记订单已支付。 */
    public void markPaid(long orderId) {
        paymentService.charge(orderId);
        orderDao.updateStatus(orderId, "PAID");
    }

    /** 取消订单。 */
    public void cancelOrder(long orderId) {
        orderDao.updateStatus(orderId, "CANCELED");
    }

    /** 按编号查询订单。 */
    public Order findOrder(long orderId) {
        return orderDao.findById(orderId);
    }
}
'''

FILES["service/PaymentService.java"] = '''package com.shop.service;

import com.shop.dao.OrderDao;

/**
 * 支付业务：扣款与回写支付状态。
 */
public class PaymentService {

    private OrderDao orderDao;

    /** 对订单发起扣款。 */
    public void charge(long orderId) {
        orderDao.updateStatus(orderId, "CHARGING");
        orderDao.updateStatus(orderId, "PAID");
    }
}
'''

FILES["service/CartService.java"] = '''package com.shop.service;

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
'''

FILES["service/ProductService.java"] = '''package com.shop.service;

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
'''

FILES["dao/OrderDao.java"] = '''package com.shop.dao;

import com.shop.model.Order;
import java.util.ArrayList;
import java.util.List;

/**
 * 订单数据访问：内存表的增删改查。
 */
public class OrderDao {

    private List<Order> orders = new ArrayList<>();
    private long seq = 0;

    /** 插入订单并返回编号。 */
    public long insert(Order order) {
        seq = seq + 1;
        order.setId(seq);
        orders.add(order);
        return seq;
    }

    /** 更新订单状态。 */
    public void updateStatus(long orderId, String status) {
        Order found = findById(orderId);
        if (found != null) {
            found.setStatus(status);
        }
    }

    /** 按编号查找订单。 */
    public Order findById(long orderId) {
        for (Order order : orders) {
            if (order.getId() == orderId) {
                return order;
            }
        }
        return null;
    }
}
'''

FILES["dao/CartDao.java"] = '''package com.shop.dao;

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
'''

FILES["dao/ProductDao.java"] = '''package com.shop.dao;

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
'''

FILES["dao/UserDao.java"] = '''package com.shop.dao;

import com.shop.model.User;
import java.util.ArrayList;
import java.util.List;

/**
 * 用户数据访问。
 */
public class UserDao {

    private List<User> users = new ArrayList<>();

    /** 按编号查询用户。 */
    public User findById(long id) {
        for (User user : users) {
            if (user.getId() == id) {
                return user;
            }
        }
        return null;
    }

    /** 按手机号查询用户。 */
    public User findByPhone(String phone) {
        for (User user : users) {
            if (phone.equals(user.getPhone())) {
                return user;
            }
        }
        return null;
    }

    /** 新增用户。 */
    public long insert(User user) {
        users.add(user);
        return user.getId();
    }

    /** 更新用户名称。 */
    public void updateName(long id, String name) {
        User found = findById(id);
        if (found != null) {
            found.setName(name);
        }
    }
}
'''

FILES["model/Order.java"] = '''package com.shop.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 订单：编号、状态、金额与明细。
 */
public class Order {

    private long id;
    private String status;
    private long total;
    private List<OrderLine> lines = new ArrayList<>();

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public long getTotal() {
        return total;
    }

    public void setTotal(long total) {
        this.total = total;
    }

    public List<OrderLine> getLines() {
        return lines;
    }
}
'''

FILES["model/OrderLine.java"] = '''package com.shop.model;

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
'''

FILES["model/Cart.java"] = '''package com.shop.model;

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
'''

FILES["model/CartItem.java"] = '''package com.shop.model;

/**
 * 购物车条目。
 */
public class CartItem {

    private long id;
    private long userId;
    private long productId;
    private int count;

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public long getUserId() {
        return userId;
    }

    public void setUserId(long userId) {
        this.userId = userId;
    }

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
}
'''

FILES["model/Product.java"] = '''package com.shop.model;

/**
 * 商品：编号、名称、价格与库存。
 */
public class Product {

    private long id;
    private String name;
    private long price;
    private int stock;

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public long getPrice() {
        return price;
    }

    public void setPrice(long price) {
        this.price = price;
    }

    public int getStock() {
        return stock;
    }

    public void setStock(int stock) {
        this.stock = stock;
    }
}
'''

FILES["model/ProductPage.java"] = '''package com.shop.model;

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
'''

FILES["model/User.java"] = '''package com.shop.model;

/**
 * 用户：编号、名称与手机号。
 */
public class User {

    private long id;
    private String name;
    private String phone;

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }
}
'''

FILES["util/MoneyUtil.java"] = '''package com.shop.util;

import com.shop.model.OrderLine;
import java.util.List;

/**
 * 金额计算工具。
 */
public final class MoneyUtil {

    private MoneyUtil() {
    }

    /** 汇总所有明细的金额。 */
    public static long sum(List<OrderLine> lines) {
        long total = 0;
        for (OrderLine line : lines) {
            total = total + line.getPrice() * line.getCount();
        }
        return total;
    }

    /** 把分转换成元，保留两位。 */
    public static String format(long cents) {
        return String.format("%d.%02d", cents / 100, cents % 100);
    }
}
'''

FILES["util/IdGenerator.java"] = '''package com.shop.util;

/**
 * 简易编号生成器。
 */
public class IdGenerator {

    private static long current = 1000;

    /** 生成下一个编号。 */
    public static long next() {
        current = current + 1;
        return current;
    }

    /** 查看当前编号。 */
    public static long current() {
        return current;
    }
}
'''


def main():
    for relative, content in FILES.items():
        path = os.path.join(ROOT, relative.replace("/", os.sep))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
    print("写入 %d 个 Java 文件到 %s" % (len(FILES), ROOT))


if __name__ == "__main__":
    main()
