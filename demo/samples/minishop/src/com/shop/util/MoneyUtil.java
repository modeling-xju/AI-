package com.shop.util;

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
