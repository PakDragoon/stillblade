# Map art credits

All third-party source art used for the greybox map is **CC0 (public domain)** from
[Poly Haven](https://polyhaven.com) (licence: https://polyhaven.com/license). No attribution is
required; it is recorded here for provenance.

Raw downloads live in `tools/blender/source-art/` (not committed, see `.gitignore`).
`tools/blender/greybox.py` processes them into the shipped files in this folder
(resize, detile, contrast/saturation/albedo normalisation, WebP; HDRI -> tonemapped sky strip).

## Used in the shipped map

| Shipped file | Source asset | Downloaded file (URL) | Size (bytes) | Licence |
|---|---|---|---|---|
| tex_floor.webp | [concrete_floor_02](https://polyhaven.com/a/concrete_floor_02) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_floor_02/concrete_floor_02_diff_1k.jpg | 776097 | CC0 |
| tex_wall_outer.webp | [factory_brick](https://polyhaven.com/a/factory_brick) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/factory_brick/factory_brick_diff_1k.jpg | 1018112 | CC0 |
| tex_wall_inner.webp | [concrete_wall_004](https://polyhaven.com/a/concrete_wall_004) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg | 531968 | CC0 |
| tex_crate.webp | [raw_plank_wall](https://polyhaven.com/a/raw_plank_wall) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/raw_plank_wall/raw_plank_wall_diff_1k.jpg | 640551 | CC0 |
| tex_metal.webp | [blue_metal_plate](https://polyhaven.com/a/blue_metal_plate) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/blue_metal_plate/blue_metal_plate_diff_1k.jpg | 395923 | CC0 |
| sky.jpg + bake lighting | [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr | 5451493 | CC0 |

The HDRI is by Greg Zaal (original) and Jarod Guest (sky edit); the textures' authors are listed on
each asset page.

## Downloaded for comparison, not used

All CC0, Poly Haven diffuse maps (1k JPG), `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/<asset>/<asset>_diff_1k.jpg`:

| Asset | Size (bytes) |
|---|---|
| [concrete_floor_worn_001](https://polyhaven.com/a/concrete_floor_worn_001) | 118806 |
| [hangar_concrete_floor](https://polyhaven.com/a/hangar_concrete_floor) | 614854 |
| [concrete_pavement](https://polyhaven.com/a/concrete_pavement) | 926197 |
| [large_red_bricks](https://polyhaven.com/a/large_red_bricks) | 616870 |
| [concrete_block_wall](https://polyhaven.com/a/concrete_block_wall) | 848947 |
| [plastered_wall_02](https://polyhaven.com/a/plastered_wall_02) | 436395 |
| [brown_planks_05](https://polyhaven.com/a/brown_planks_05) | 298909 |
| [metal_plate_02](https://polyhaven.com/a/metal_plate_02) | 625917 |
| [painted_metal_shutter](https://polyhaven.com/a/painted_metal_shutter) | 627333 |
| [concrete_tiles](https://polyhaven.com/a/concrete_tiles) | 868831 |
| [concrete_floor_03](https://polyhaven.com/a/concrete_floor_03) | 1184196 |
| [brushed_concrete_03](https://polyhaven.com/a/brushed_concrete_03) | 892099 |
| [gravel_concrete_04](https://polyhaven.com/a/gravel_concrete_04) | 935651 |
| [asphalt_floor](https://polyhaven.com/a/asphalt_floor) | 1152035 |
| [painted_concrete](https://polyhaven.com/a/painted_concrete) | 995059 |
