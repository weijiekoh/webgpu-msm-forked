@group(0) @binding(0)
var<storage, read> scalars: array<u32>;
@group(0) @binding(1)
var<storage, read_write> result: array<u32>;

const NUM_SUBTASKS = {{ num_subtasks }}u;
const CHUNK_SIZE = {{ chunk_size }}u;

{{ > extract_word_from_bytes_le_funcs }}

@compute
@workgroup_size({{ workgroup_size }})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let gidx = global_id.x; 

    var scalar_bytes: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) {
        scalar_bytes[15u - i] = scalars[gidx * 16 + i];
    }

    for (var i = 0u; i < NUM_SUBTASKS; i++) {
        let offset = i * 65536;
        result[gidx + offset] = extract_word_from_bytes_le(scalar_bytes, i);
    }

    result[gidx + 19 * 65536] = scalar_bytes[0] >> (((NUM_SUBTASKS * CHUNK_SIZE - 256u) + 16u) - CHUNK_SIZE);
}
