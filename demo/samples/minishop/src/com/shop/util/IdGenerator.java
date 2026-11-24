package com.shop.util;

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
