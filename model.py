"""
Kiến trúc model: 1 CNN backbone dùng chung + N "đầu" (head) phân loại,
mỗi head chịu trách nhiệm đoán 1 ô ký tự cố định trên màn hình.
Đây là kiểu kiến trúc đơn giản, nhẹ, rất hợp để chạy real-time trên trình duyệt qua TF.js.
"""
import tensorflow as tf
from tensorflow.keras import layers, models

import config


def build_model(img_height=None, img_width=None, num_slots=None, num_classes=None):
    img_height = img_height or config.IMG_HEIGHT
    img_width = img_width or config.IMG_WIDTH
    num_slots = num_slots or config.NUM_SLOTS
    num_classes = num_classes or config.NUM_CLASSES

    inputs = layers.Input(shape=(img_height, img_width, 1), name="image")

    x = layers.Rescaling(1.0 / 255.0)(inputs)

    x = layers.Conv2D(32, 3, padding="same", activation="relu")(x)
    x = layers.BatchNormalization()(x)
    x = layers.MaxPooling2D()(x)  # /2

    x = layers.Conv2D(64, 3, padding="same", activation="relu")(x)
    x = layers.BatchNormalization()(x)
    x = layers.MaxPooling2D()(x)  # /4

    x = layers.Conv2D(128, 3, padding="same", activation="relu")(x)
    x = layers.BatchNormalization()(x)
    x = layers.MaxPooling2D()(x)  # /8

    x = layers.Conv2D(128, 3, padding="same", activation="relu")(x)
    x = layers.BatchNormalization()(x)
    x = layers.MaxPooling2D()(x)  # /16

    x = layers.Dropout(0.3)(x)
    x = layers.Flatten()(x)
    x = layers.Dense(256, activation="relu")(x)
    x = layers.Dropout(0.3)(x)

    outputs = []
    for i in range(num_slots):
        head = layers.Dense(128, activation="relu", name=f"head{i}_fc")(x)
        out = layers.Dense(num_classes, activation="softmax", name=f"slot{i}")(head)
        outputs.append(out)

    model = models.Model(inputs=inputs, outputs=outputs, name="screen_digit_ocr")
    return model


if __name__ == "__main__":
    m = build_model()
    m.summary()
