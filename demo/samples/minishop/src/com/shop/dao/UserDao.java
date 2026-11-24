package com.shop.dao;

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
