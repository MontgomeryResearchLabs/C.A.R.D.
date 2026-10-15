# Real-hardware build of the ball-tilt maze for the JT business card (RP2350A).
#
#   export PICO_SDK_PATH=~/pico/pico-sdk
#   mkdir build && cd build
#   cmake .. -DPICO_BOARD=pico2
#   make -j
#   -> maze_demo.uf2  (hold BOOT, plug USB-C, copy to the RP2350 drive)
#
# Display + accelerometer drivers and board.h come from ../fluid-demo.
cmake_minimum_required(VERSION 3.13)

include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(maze_demo C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

set(SHARED ${CMAKE_CURRENT_LIST_DIR}/../fluid-demo)
add_executable(maze_demo main.c maze.c ${SHARED}/charlieplex.c ${SHARED}/lis2dh12.c)
target_include_directories(maze_demo PRIVATE ${SHARED})
target_link_libraries(maze_demo pico_stdlib pico_multicore hardware_i2c)

pico_enable_stdio_usb(maze_demo 1)
pico_enable_stdio_uart(maze_demo 0)

# The card's flash is a 4 MB ZD25WQ32 (32 Mbit)
target_compile_definitions(maze_demo PRIVATE PICO_FLASH_SIZE_BYTES=4194304)

pico_add_extra_outputs(maze_demo)
