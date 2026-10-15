# Real-hardware build for the JT business card (RP2350A).
#
#   export PICO_SDK_PATH=~/pico/pico-sdk
#   mkdir build && cd build
#   cmake .. -DPICO_BOARD=pico2      # pico2 = RP2350A + 4 MB-class QSPI flash
#   make -j
#   -> fluid_demo.uf2  (hold BOOT, plug USB-C, copy to the RP2350 drive)
#
# The very same .c files are compiled for the simulator by
#   node ../../tools/build-firmware.mjs .
cmake_minimum_required(VERSION 3.13)

include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(fluid_demo C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

add_executable(fluid_demo main.c charlieplex.c lis2dh12.c fluid.c)
target_link_libraries(fluid_demo pico_stdlib pico_multicore hardware_i2c)

# printf over USB CDC (the card has USB-C but no UART header)
pico_enable_stdio_usb(fluid_demo 1)
pico_enable_stdio_uart(fluid_demo 0)

# The card's flash is a 4 MB ZD25WQ32 (32 Mbit)
target_compile_definitions(fluid_demo PRIVATE PICO_FLASH_SIZE_BYTES=4194304)

pico_add_extra_outputs(fluid_demo)
