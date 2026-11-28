# Map art credits

All third-party source art used for the maps (Training Yard = `greybox`, Warehouse = `warehouse`, Dry Creek = `drycreek`) is **CC0 (public domain)** from
[Poly Haven](https://polyhaven.com) (licence: https://polyhaven.com/license). No attribution is
required; it is recorded here for provenance.

Raw downloads live in `tools/blender/source-art/` (not committed, see `.gitignore`).
The map builder (`tools/blender/mapbuilder.py`, texture list in `mapkit.TEXTURE_LIBRARY`) processes them into the shipped files in this folder
(resize, detile, contrast/saturation/albedo normalisation, WebP; HDRI -> tonemapped sky strip).

## Used in the shipped maps

| Shipped file | Source asset | Downloaded file (URL) | Size (bytes) | Licence |
|---|---|---|---|---|
| tex_floor.webp | [concrete_floor_02](https://polyhaven.com/a/concrete_floor_02) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_floor_02/concrete_floor_02_diff_1k.jpg | 776097 | CC0 |
| tex_wall_outer.webp | [factory_brick](https://polyhaven.com/a/factory_brick) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/factory_brick/factory_brick_diff_1k.jpg | 1018112 | CC0 |
| tex_wall_inner.webp | [concrete_wall_004](https://polyhaven.com/a/concrete_wall_004) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg | 531968 | CC0 |
| tex_crate.webp (both maps) | [raw_plank_wall](https://polyhaven.com/a/raw_plank_wall) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/raw_plank_wall/raw_plank_wall_diff_1k.jpg | 640551 | CC0 |
| tex_metal.webp | [blue_metal_plate](https://polyhaven.com/a/blue_metal_plate) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/blue_metal_plate/blue_metal_plate_diff_1k.jpg | 395923 | CC0 |
| tex_wh_floor.webp (Warehouse) | [hangar_concrete_floor](https://polyhaven.com/a/hangar_concrete_floor) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/hangar_concrete_floor/hangar_concrete_floor_diff_1k.jpg | 614854 | CC0 |
| tex_wh_block.webp (Warehouse) | [concrete_block_wall](https://polyhaven.com/a/concrete_block_wall) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_block_wall/concrete_block_wall_diff_1k.jpg | 848947 | CC0 |
| tex_wh_paint.webp (Warehouse) | [plastered_wall_02](https://polyhaven.com/a/plastered_wall_02) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/plastered_wall_02/plastered_wall_02_diff_1k.jpg | 436395 | CC0 |
| tex_wh_metal.webp (Warehouse) | [metal_plate_02](https://polyhaven.com/a/metal_plate_02) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/metal_plate_02/metal_plate_02_diff_1k.jpg | 625917 | CC0 |
| tex_wh_tiles.webp (Warehouse) | [concrete_tiles](https://polyhaven.com/a/concrete_tiles) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_tiles/concrete_tiles_diff_1k.jpg | 868831 | CC0 |
| tex_dc_ground.webp (Dry Creek: sand and gravel) | [gravelly_sand](https://polyhaven.com/a/gravelly_sand) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/gravelly_sand/gravelly_sand_diff_1k.jpg | 1062525 | CC0 |
| tex_dc_concrete.webp (Dry Creek: concrete, also under its paint) | [concrete_wall_004](https://polyhaven.com/a/concrete_wall_004) (the same source as tex_wall_inner, processed warmer) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg | 531968 | CC0 |
| tex_dc_metal.webp (Dry Creek: corrugated sheet, containers, roofs, the walkway) | [corrugated_iron_02](https://polyhaven.com/a/corrugated_iron_02) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/corrugated_iron_02/corrugated_iron_02_diff_1k.jpg | 568492 | CC0 |
| tex_dc_paint.webp (Dry Creek: painted metal: vehicles, tanks, machines) | [green_metal_rust](https://polyhaven.com/a/green_metal_rust) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/green_metal_rust/green_metal_rust_diff_1k.jpg | 212088 | CC0 |
| tex_dc_wood.webp (Dry Creek: plywood huts, crates) | [oriented_strand_board](https://polyhaven.com/a/oriented_strand_board) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oriented_strand_board/oriented_strand_board_diff_1k.jpg | 1017205 | CC0 |
| tex_dc_fabric.webp (Dry Creek: Hesco liners, sandbags, truck canvas) | [hessian_230](https://polyhaven.com/a/hessian_230) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/hessian_230/hessian_230_diff_1k.jpg | 1062404 | CC0 |
| sky.jpg + bake lighting (all three maps; Dry Creek warms the sun and the sky's light in the bake) | [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr | 5451493 | CC0 |

The HDRI is by Greg Zaal (original) and Jarod Guest (sky edit); the textures' authors are listed on
each asset page.

## Downloaded for comparison, not used

All CC0, Poly Haven diffuse maps (1k JPG), `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/<asset>/<asset>_diff_1k.jpg`:

| Asset | Size (bytes) |
|---|---|
| [concrete_floor_worn_001](https://polyhaven.com/a/concrete_floor_worn_001) | 118806 |
| [concrete_pavement](https://polyhaven.com/a/concrete_pavement) | 926197 |
| [large_red_bricks](https://polyhaven.com/a/large_red_bricks) | 616870 |
| [brown_planks_05](https://polyhaven.com/a/brown_planks_05) | 298909 |
| [painted_metal_shutter](https://polyhaven.com/a/painted_metal_shutter) | 627333 |
| [concrete_floor_03](https://polyhaven.com/a/concrete_floor_03) | 1184196 |
| [brushed_concrete_03](https://polyhaven.com/a/brushed_concrete_03) | 892099 |
| [gravel_concrete_04](https://polyhaven.com/a/gravel_concrete_04) | 935651 |
| [asphalt_floor](https://polyhaven.com/a/asphalt_floor) | 1152035 |
| [painted_concrete](https://polyhaven.com/a/painted_concrete) | 995059 |

Downloaded for Dry Creek and not used (all CC0, Poly Haven, 1k diffuse JPG unless noted):
[dry_ground_01](https://polyhaven.com/a/dry_ground_01) 604799, [concrete_slab_wall_02](https://polyhaven.com/a/concrete_slab_wall_02) 595743,
[precast_concrete_wall](https://polyhaven.com/a/precast_concrete_wall) 801751, [corrugated_iron_03](https://polyhaven.com/a/corrugated_iron_03) 479372,
[container_side](https://polyhaven.com/a/container_side) 667470, [plywood](https://polyhaven.com/a/plywood) 882059 bytes, and the HDRI
[qwantani_afternoon_puresky](https://polyhaven.com/a/qwantani_afternoon_puresky) (2k .hdr, 4225710 bytes): a new sky would move the sun,
whose direction is shared with the players' lighting (`client/src/lighting.ts`), so Dry Creek keeps the shared sky and warms it in the bake.

No new files were downloaded for the Warehouse: it uses textures that were already in `source-art/` (listed above), plus `tex_crate.webp`, the sky and the HDRI shared with Test Map 1. `painted_concrete` was tried for the Warehouse's painted surfaces and replaced by `plastered_wall_02`.
