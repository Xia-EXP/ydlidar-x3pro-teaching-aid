"""Render the four original, silent case diagrams (Pillow + FFmpeg)."""
import math
import os
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SIZE = (840, 472)
FPS = 12
CHAPTER = 6
FONT = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
TEXT = ImageFont.truetype(str(FONT), 22)
TITLE = ImageFont.truetype(str(FONT), 32)
SMALL = ImageFont.truetype(str(FONT), 16)
INK, MUTED, GRID = "#e8f2fb", "#9cb5ca", "#284055"
TEAL, ORANGE, RED, BLUE = "#4aded0", "#ffbb72", "#ff7887", "#78a9ff"

LESSONS = {
    "g1-avoidance": ("G1 避障演示", [
        ("前方通畅", "扫描一圈，前方清距足够，给出前进建议。"),
        ("左前方受阻", "左前方出现障碍，比较两侧清距，向右转。"),
        ("进入停止距离", "障碍靠得太近，停在原地。"),
        ("通路恢复", "下一圈重新测量，清距足够再前进。"),
    ]),
    "g1-slalom": ("G1 绕桩路径示意", [
        ("定位第一根桩", "从出发点观察第一根桩，先选一侧通过。"),
        ("绕过第一根桩", "走过一根桩后，重新观察下一段通路。"),
        ("交替选边", "后续障碍交错排列，需要逐段更新路线。"),
        ("到达终点", "把每段走向连在一起，得到示例路线。"),
    ]),
    "gap-following": ("缝隙跟随法", [
        ("读取与限距", "每条射线是一个方向的距离读数，先处理量程。"),
        ("找最近点", "找出最近的回波点，确定需要避让的障碍。"),
        ("划出安全范围", "排除障碍附近的方向，为车身留出余量。"),
        ("选缝与目标方向", "在剩余的最大连续区间内选一个方向。"),
    ]),
    "tf-frames": ("TF 与坐标", [
        ("雷达读数", "同一个点可以用距离、角度或 X/Y 描述。"),
        ("转到车身坐标", "知道雷达的安装朝向后，把坐标转到车身轴。"),
        ("转到地图坐标", "再用车身在地图中的位置和朝向换算坐标。"),
        ("核对固定障碍", "雷达坐标可能变化，固定障碍的地图位置不变。"),
    ]),
}


def dot(draw, xy, color, radius=5):
    x, y = xy
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def arrow(draw, origin, end, color, width=3):
    draw.line((origin, end), fill=color, width=width)
    angle = math.atan2(end[1] - origin[1], end[0] - origin[0])
    tip = [
        (end[0] - 10 * math.cos(angle + side * 0.52),
         end[1] - 10 * math.sin(angle + side * 0.52))
        for side in (-1, 1)
    ]
    draw.polygon([end, *tip], fill=color)


def direction(origin, degrees, length):
    radians = math.radians(degrees)
    return origin[0] + math.sin(radians) * length, origin[1] - math.cos(radians) * length


def avoid(draw, scene, phase):
    origin = (435, 347)
    for r in (55, 98, 147):
        draw.arc((origin[0]-r, origin[1]-r, origin[0]+r, origin[1]+r),
                 205, 335, fill=GRID, width=2)
    ray = direction(origin, -57 + 114 * (phase * 3 % 1), 148)
    draw.line((origin, ray), fill=BLUE, width=2)
    if scene in (1, 2):
        obstacle = (391, 269) if scene == 1 else (435, 306)
        color = ORANGE if scene == 1 else RED
        x, y = obstacle
        draw.rounded_rectangle((x-14, y-9, x+14, y+9), radius=3, fill=color)
        draw.text((x-18, y-34), "障碍", font=SMALL, fill=color)
    if scene == 2:
        draw.ellipse((415, 327, 455, 367), outline=RED, width=3)
        draw.text((542, 277), "停止", font=TITLE, fill=RED)
    else:
        angle = 44 if scene == 1 else 0
        arrow(draw, origin, direction(origin, angle, 85 + 44 * phase), TEAL, 4)
        draw.text((575, 258), "右转" if scene == 1 else "前进", font=TITLE, fill=TEAL)
    dot(draw, origin, INK, 7)


def slalom(draw, scene, phase):
    route = [(150, 284), (271, 235), (420, 335), (555, 239), (705, 280)]
    draw.line((686, 207, 686, 353), fill=TEAL, width=2)
    draw.text((697, 215), "终点", fill=TEAL, font=SMALL)
    for post in [(275, 291), (421, 267), (552, 305)]:
        dot(draw, post, ORANGE, 12)
    draw.line(route, fill=GRID, width=3)
    start, end = route[scene:scene + 2]
    pos = tuple(a + (b - a) * phase for a, b in zip(start, end))
    draw.line([*route[:scene + 1], pos], fill=TEAL, width=4)
    dot(draw, pos, INK, 9)


def gap(draw, scene, phase):
    origin = (425, 353)
    for angle in range(-60, 61, 6):
        short = -42 <= angle <= -12 or 36 <= angle <= 54
        length = 85 if short else 154
        color = (ORANGE if short else GRID)
        if scene >= 2 and -48 <= angle <= -6:
            color = RED
        if scene == 3 and 0 <= angle <= 30:
            color = TEAL
        end = direction(origin, angle, length)
        draw.line((origin, end), fill=color, width=2)
        dot(draw, end, color, 3)
    if scene == 1:
        dot(draw, direction(origin, -24, 85), RED, 7)
    if scene >= 2:
        x, y = direction(origin, -24, 85)
        radius = 26 + 6 * phase
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), outline=RED, width=2)
    if scene == 3:
        arrow(draw, origin, direction(origin, 15, 153), INK, 4)
    dot(draw, origin, INK, 6)


def frames(draw, scene, phase):
    target = (572, 236)
    coordinate_origins = [(404, 329), (335, 311), (213, 346), (455, 321)]
    for index, origin in enumerate(coordinate_origins[:scene + 1]):
        angle = [-27, 18, 0, 39][index]
        color = [TEAL, BLUE, ORANGE, TEAL][index]
        if index == 3:
            origin = (404 + 51 * phase, 329 - 8 * phase)
        for offset, name in ((0, "X"), (-90, "Y")):
            end = direction(origin, angle + offset, 64)
            arrow(draw, origin, end, color)
            draw.text(end, name, font=SMALL, fill=color)
        draw.line((origin, target), fill=color, width=2)
        dot(draw, origin, color)
    dot(draw, target, RED, 8)
    draw.text((590, 220), "固定障碍", fill=INK, font=TEXT)


RENDER = dict(zip(LESSONS, [avoid, slalom, gap, frames]))


def render_frame(lesson, frame_number):
    title, chapters = LESSONS[lesson]
    scene, tick = divmod(frame_number, FPS * CHAPTER)
    heading, caption = chapters[scene]
    frame = Image.new("RGB", SIZE, "#0b1725")
    draw = ImageDraw.Draw(frame)
    draw.text((34, 22), title, fill=INK, font=TITLE)
    draw.text((628, 33), "X3 PRO 雷达教学", fill=MUTED, font=SMALL)
    draw.line((34, 76, 806, 76), fill=GRID, width=2)
    draw.text((35, 97), heading, fill=TEAL, font=TEXT)
    draw.rounded_rectangle((34, 139, 806, 389), radius=12, fill="#112335", outline=GRID)
    for x in range(58, 806, 28):
        for y in range(154, 389, 28):
            dot(draw, (x, y), GRID, 1)
    RENDER[lesson](draw, scene, tick / (FPS * CHAPTER - 1))
    draw.text((35, 408), caption, fill=INK, font=TEXT)
    for i in range(len(chapters)):
        x = 35 + i * 194
        draw.rectangle((x, 453, x+179, 456), fill=TEAL if i <= scene else GRID)
    return frame


def main():
    for lesson, (_, chapters) in LESSONS.items():
        output = ROOT / "public" / "media" / f"{lesson}.mp4"
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{SIZE[0]}x{SIZE[1]}", "-r", str(FPS), "-i", "pipe:0",
            "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
        ]
        with subprocess.Popen(command, stdin=subprocess.PIPE) as process:
            for frame_number in range(len(chapters) * FPS * CHAPTER):
                process.stdin.write(render_frame(lesson, frame_number).tobytes())
            process.stdin.close()
            if process.wait():
                raise RuntimeError(f"FFmpeg failed for {lesson}")


if __name__ == "__main__":
    main()
