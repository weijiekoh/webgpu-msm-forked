import mustache from 'mustache'
import { BigIntPoint } from "../../reference/types"
import {
    get_device,
    create_and_write_sb,
    create_bind_group,
    create_bind_group_layout,
    create_compute_pipeline,
    create_sb,
    read_from_gpu,
    execute_pipeline,
} from '../gpu'
import {
    to_words_le,
    gen_p_limbs,
    gen_r_limbs,
    gen_mu_limbs,
    u8s_to_bigints,
    u8s_to_numbers,
    u8s_to_numbers_32,
    numbers_to_u8s_for_gpu,
    bigints_to_16_bit_words_for_gpu,
    bigints_to_u8_for_gpu,
    compute_misc_params,
    decompose_scalars,
} from '../utils'
import assert from 'assert'

import convert_point_coords_shader from '../wgsl/convert_point_coords.template.wgsl'
import extract_word_from_bytes_le_funcs from '../wgsl/extract_word_from_bytes_le.template.wgsl'
import structs from '../wgsl/struct/structs.template.wgsl'
import bigint_funcs from '../wgsl/bigint/bigint.template.wgsl'
import field_funcs from '../wgsl/field/field.template.wgsl'
import ec_funcs from '../wgsl/curve/ec.template.wgsl'
import barrett_functions from '../wgsl/barrett.template.wgsl'
import montgomery_product_funcs from '../wgsl/montgomery/mont_pro_product.template.wgsl'
import decompose_scalars_shader from '../wgsl/decompose_scalars.template.wgsl'
import gen_csr_precompute_shader from '../wgsl/gen_csr_precompute.template.wgsl'
import preaggregation_stage_1_shader from '../wgsl/preaggregation_stage_1.template.wgsl'
import preaggregation_stage_2_shader from '../wgsl/preaggregation_stage_2.template.wgsl'

// Hardcode params for word_size = 13
const p = BigInt('8444461749428370424248824938781546531375899335154063827935233455917409239041')
const r = BigInt('3336304672246003866643098545847835280997800251509046313505217280697450888997')
const word_size = 13
const num_words = 20

/*
 * End-to-end implementation of the cuZK MSM algorithm.
 */
export const cuzk_gpu = async (
    baseAffinePoints: BigIntPoint[],
    scalars: bigint[]
): Promise<{x: bigint, y: bigint}> => {
    // Determine the optimal window size dynamically based on a static analysis 
    // of varying input sizes. This will be determined using a seperate function.   
    const input_size = scalars.length
    const num_subtasks = 16
    const chunk_size = Math.ceil(256 / num_subtasks)
    const word_size = 13

    // Each pass must use the same GPUDevice and GPUCommandEncoder, or else
    // storage buffers can't be reused across compute passes
    const device = await get_device()
    const commandEncoder = device.createCommandEncoder()

    // Convert the affine points to Montgomery form in the GPU
    const { point_x_y_sb, point_t_z_sb } =
        await convert_point_coords_to_mont_gpu(
            device,
            commandEncoder,
            baseAffinePoints,
            num_subtasks, 
            word_size,
            false,
        )

    // Decompose the scalars
    const scalar_chunks_sb = await decompose_scalars_gpu(
        device,
        commandEncoder,
        scalars,
        num_subtasks,
        chunk_size,
        true,
    )

    for (let subtask_idx = 0; subtask_idx < num_subtasks; subtask_idx ++) {
        break
        // TODO: if debug is set to true in any invocations within a loop, the
        // sanity check will fail on the second iteration, because the
        // commandEncoder's finish() function has been used. To correctly
        // sanity-check these outputs, do so in a separate test file.
        const {
            new_point_indices_sb,
            cluster_start_indices_sb,
            cluster_end_indices_sb,
        } = await csr_precompute_gpu(
            device,
            commandEncoder,
            input_size,
            num_subtasks,
            subtask_idx,
            chunk_size,
            scalar_chunks_sb,
            true,
        )
        break

        const {
            new_point_x_y_sb,
            new_point_t_z_sb,
        } = await pre_aggregation_stage_1_gpu(
            device,
            commandEncoder,
            input_size,
            point_x_y_sb,
            point_t_z_sb,
            new_point_indices_sb,
            cluster_start_indices_sb,
            cluster_end_indices_sb,
            false,
        )

        const new_scalar_chunks_sb = await pre_aggregation_stage_2_gpu(
            device,
            commandEncoder,
            input_size,
            scalar_chunks_sb,
            cluster_start_indices_sb,
            new_point_indices_sb,
            false,
        )

        // TODO: produce row_idx
        // TODO: perform transposition
        // TODO: perform SMVP
        // TODO: final step
    }
    device.destroy()

    return { x: BigInt(1), y: BigInt(0) }
}

/*
 * Convert the affine points to Montgomery form

 * ASSUMPTION: the vast majority of WebGPU-enabled consumer devices have a
 * maximum buffer size of at least 268435456 bytes.
 * 
 * The default maximum buffer size is 268435456 bytes. Since each point
 * consumes 320 bytes, a maximum of around 2 ** 19 points can be stored in a
 * single buffer. If, however, we use 4 buffers - one for each point coordiante
 * X, Y, T, and Z - we can support up an input size of up to 2 ** 21 points.
 * Our implementation, however, will only support up to 2 ** 20 points as that
 * is the maximum input size for the ZPrize competition.
 * 
 * The test harness readme at https://github.com/demox-labs/webgpu-msm states:
 * "The submission should produce correct outputs on input vectors with length
 * up to 2^20. The evaluation will be using input randomly sampled from size
 * 2^16 ~ 2^20."
*/
export const convert_point_coords_to_mont_gpu = async (
    device: GPUDevice,
    commandEncoder: GPUCommandEncoder,
    baseAffinePoints: BigIntPoint[],
    num_subtasks: number,
    word_size: number,
    debug = false,
): Promise<{
    point_x_y_sb: GPUBuffer,
    point_t_z_sb: GPUBuffer,
}> => {
    const input_size = baseAffinePoints.length

    // An affine point only contains X and Y points.
    const x_y_coords = Array(input_size * 2).fill(BigInt(0))
    for (let i = 0; i < input_size; i ++) {
        x_y_coords[i * 2] = baseAffinePoints[i].x
        x_y_coords[i * 2 + 1] = baseAffinePoints[i].y
    }

    // Convert points to bytes (performs ~2x faster than `bigints_to_16_bit_words_for_gpu`)
    const x_y_coords_bytes = bigints_to_u8_for_gpu(x_y_coords, num_subtasks, word_size)

    // Input buffers
    const x_y_coords_sb = create_and_write_sb(device, x_y_coords_bytes)

    // Output buffers
    const point_x_y_sb = create_sb(device, input_size * 2 * num_words * 4)
    const point_t_z_sb = create_sb(device, input_size * 2 * num_words * 4)

    const bindGroupLayout = create_bind_group_layout(
        device,
        [
            'read-only-storage',
            'storage',
            'storage',
        ],
    )
    const bindGroup = create_bind_group(
        device,
        bindGroupLayout,
        [
            x_y_coords_sb,
            point_x_y_sb,
            point_t_z_sb,
        ],
    )

    const workgroup_size = 256
    const num_x_workgroups = 256

    const shaderCode = genConvertPointCoordsShaderCode(
        workgroup_size,
    )

    const computePipeline = await create_compute_pipeline(
        device,
        [bindGroupLayout],
        shaderCode,
        'main',
    )

    // execute_pipeline(commandEncoder, computePipeline, bindGroup, num_x_workgroups, num_y_workgroups, 1);

    const passEncoder = commandEncoder.beginComputePass()
    passEncoder.setPipeline(computePipeline)
    passEncoder.setBindGroup(0, bindGroup)
    passEncoder.dispatchWorkgroups(num_x_workgroups)
    passEncoder.end()

    if (debug) {
        const data = await read_from_gpu(
            device,
            commandEncoder,
            [point_x_y_sb, point_t_z_sb],
        )
        
        const computed_x_y_coords = u8s_to_bigints(data[0], num_words, word_size)
        const computed_t_z_coords = u8s_to_bigints(data[1], num_words, word_size)

        for (let i = 0; i < input_size; i ++) {
            const expected_x = baseAffinePoints[i].x * r % p
            const expected_y = baseAffinePoints[i].y * r % p
            const expected_t = (baseAffinePoints[i].x * baseAffinePoints[i].y * r) % p
            const expected_z = r % p

            if (!(
                expected_x === computed_x_y_coords[i * 2] 
                && expected_y === computed_x_y_coords[i * 2 + 1] 
                && expected_t === computed_t_z_coords[i * 2] 
                && expected_z === computed_t_z_coords[i * 2 + 1]
            )) {
                console.log('mismatch at', i)
                debugger
                break
            }
        }
    }

    return { point_x_y_sb, point_t_z_sb }
}

const genConvertPointCoordsShaderCode = (
    workgroup_size: number,
) => {
    const word_size = 13
    const misc_params = compute_misc_params(p, word_size)
    const num_words = misc_params.num_words
    const n0 = misc_params.n0
    const mask = BigInt(2) ** BigInt(word_size) - BigInt(1)
    const r = misc_params.r
    const two_pow_word_size = 2 ** word_size
    const p_limbs = gen_p_limbs(p, num_words, word_size)
    const r_limbs = gen_r_limbs(r, num_words, word_size)
    const mu_limbs = gen_mu_limbs(p, num_words, word_size)
    const p_bitlength = p.toString(2).length
    const slack = num_words * word_size - p_bitlength
        const shaderCode = mustache.render(
        convert_point_coords_shader,
        {
            workgroup_size,
            num_words,
            word_size,
            n0,
            mask,
            two_pow_word_size,
            p_limbs,
            r_limbs,
            mu_limbs,
            w_mask: (1 << word_size) - 1,
            slack,
            num_words_mul_two: num_words * 2,
            num_words_plus_one: num_words + 1,
        },
        {
            structs,
            bigint_funcs,
            field_funcs,
            barrett_functions,
            montgomery_product_funcs,
        },
    )
    return shaderCode
}

export const decompose_scalars_gpu = async (
    device: GPUDevice,
    commandEncoder: GPUCommandEncoder,
    scalars: bigint[],
    num_subtasks: number,
    chunk_size: number,
    debug = false,
): Promise<GPUBuffer> => {
    const input_size = scalars.length
    assert(num_subtasks * chunk_size === 256)

    // Convert scalars to bytes
    const scalars_bytes = bigints_to_16_bit_words_for_gpu(scalars)

    // Input buffers
    const scalars_sb = create_and_write_sb(device, scalars_bytes)

    // Output buffer(s)
    const chunks_sb = create_sb(device, input_size * num_subtasks * 4)

    const bindGroupLayout = create_bind_group_layout(
        device,
        ['read-only-storage', 'storage'],
    )
    const bindGroup = create_bind_group(
        device,
        bindGroupLayout,
        [scalars_sb, chunks_sb],
    )

    const workgroup_size = 256
    const num_x_workgroups = 256
    const num_y_workgroups = input_size / workgroup_size / num_x_workgroups

    const shaderCode = genDecomposeScalarsShaderCode(
        workgroup_size,
        num_y_workgroups,
        num_subtasks,
        chunk_size
    )

    const computePipeline = await create_compute_pipeline(
        device,
        [bindGroupLayout],
        shaderCode,
        'main',
    )

    const passEncoder = commandEncoder.beginComputePass()
    passEncoder.setPipeline(computePipeline)
    passEncoder.setBindGroup(0, bindGroup)
    passEncoder.dispatchWorkgroups(num_x_workgroups)
    passEncoder.end()

    if (debug) {
        const data = await read_from_gpu(
            device,
            commandEncoder,
            [chunks_sb],
        )

        const computed_chunks = u8s_to_numbers(data[0])

        const all_chunks: Uint16Array[] = []

        const expected: number[] = Array(scalars.length * num_subtasks).fill(0)
        for (let i = 0; i < scalars.length; i ++) {
            const chunks = to_words_le(scalars[i], num_subtasks, chunk_size)
            all_chunks.push(chunks)
        }
        for (let i = 0; i < chunk_size; i ++) {
            for (let j = 0; j < scalars.length; j ++) {
                expected[j * chunk_size + i] = all_chunks[j][i]
            }
        }
        const decompose_scalars_original = decompose_scalars(scalars, num_subtasks, chunk_size).flat()

        debugger
        for (let i = 0; i < decompose_scalars_original.length; i ++) {
            assert(computed_chunks[i] === decompose_scalars_original[i], `mismatch at ${i}`)
        }

        //debugger

        //if (computed_chunks.length !== expected.length) {
            //throw Error('output size mismatch')
        //}

        //for (let j = 0; j < decompose_scalars_original.length; j++) {
            //let z = 0
            //for (let i = j * 65536; i < (j + 1) * 65536; i++) {
                //if (computed_chunks[i] !== decompose_scalars_original[j][z]) {
                    //throw Error(`scalar decomp mismatch at ${i}`)
                //}
                //z ++
            //}
        //}
    }

    return chunks_sb
}

const genDecomposeScalarsShaderCode = (
    workgroup_size: number,
    num_y_workgroups: number,
    num_subtasks: number,
    chunk_size: number,
) => {
    const shaderCode = mustache.render(
        decompose_scalars_shader,
        {
            workgroup_size,
            num_y_workgroups,
            num_subtasks,
            chunk_size,
        },
        {
            extract_word_from_bytes_le_funcs,
        },
    )
    return shaderCode
}

export const csr_precompute_gpu = async (
    device: GPUDevice,
    commandEncoder: GPUCommandEncoder,
    input_size: number,
    num_subtasks: number,
    subtask_idx: number,
    chunk_size: number,
    scalar_chunks_sb: GPUBuffer,
    debug = true,
): Promise<{
    new_point_indices_sb: GPUBuffer,
    cluster_start_indices_sb: GPUBuffer,
    cluster_end_indices_sb: GPUBuffer,
}> => {
    const max_chunk_val = 2 ** chunk_size

    //const test_scalar_chunks = 
        //[
            //0, 1, 1, 1, 1, 1, 6, 7,
            //0, 10, 12, 13, 4, 4, 6, 7,
        //]
        ////[0, 29127, 58254, 21845, 50972, 14563, 43690, 7281,
        ////36407, 65534, 29125, 58252, 21843, 50970, 14561, 0]
    //const test_scalar_chunks_bytes = numbers_to_u8s_for_gpu(test_scalar_chunks)
    //scalar_chunks_sb = create_and_write_sb(device, test_scalar_chunks_bytes)

    // This is a serial operation, so only 1 shader should be used
    const num_x_workgroups = 1
    const num_y_workgroups = 1 

    const max_cluster_size = 4
    const overflow_size = max_chunk_val - max_cluster_size

    // Output buffers
    //const decomposed_scalars_sb = create_and_write_sb(device, decomposed_scalars_array)
    const new_point_indices_sb = create_sb(device, input_size * 4)
    const cluster_start_indices_sb = create_sb(device, input_size * 4)
    const cluster_end_indices_sb = create_sb(device, input_size * 4)
    const map_sb = create_sb(device, (max_cluster_size + 1) * max_chunk_val * 4)
    const overflow_sb = create_sb(device, overflow_size * 4)
    const keys_sb = create_sb(device, max_chunk_val * 4)
    const subtask_idx_sb = create_and_write_sb(
        device,
        numbers_to_u8s_for_gpu([subtask_idx]),
    )

    const bindGroupLayout = create_bind_group_layout(
        device,
        [
            'read-only-storage',
            'read-only-storage',
            'storage',
            'storage',
            'storage',
            'storage',
            'storage',
            'storage',
        ]
    )

    // Reuse the output buffer from the scalar decomp step as one of the input buffers
    const bindGroup = create_bind_group(
        device,
        bindGroupLayout,
        [
            scalar_chunks_sb,
            subtask_idx_sb,
            new_point_indices_sb,
            cluster_start_indices_sb,
            cluster_end_indices_sb,
            map_sb,
            overflow_sb,
            keys_sb
        ],
    )

    const shaderCode = genCsrPrecomputeShaderCode(
        num_y_workgroups,
        max_chunk_val,
		input_size,
        num_subtasks,
        max_cluster_size,
        overflow_size,
    )

    const computePipeline = await create_compute_pipeline(
        device,
        [bindGroupLayout],
        shaderCode,
        'main',
    )

    execute_pipeline(commandEncoder, computePipeline, bindGroup, num_x_workgroups, num_y_workgroups, 1);

    if (debug) {
        const data = await read_from_gpu(
            device,
            commandEncoder,
            [
                new_point_indices_sb,
                cluster_start_indices_sb,
                cluster_end_indices_sb,
                scalar_chunks_sb,
                map_sb,
            ],
        )

        const [
            new_point_indices,
            cluster_start_indices,
            cluster_end_indices,
            scalar_chunks,
            map,
        ] = data.map(u8s_to_numbers_32)

        //console.log("new_point_indices_sb is: ", new_point_indices)
        //console.log("cluster_start_indices_sb is: ", cluster_start_indices)
        //console.log("cluster_end_indices_sb is: ", cluster_end_indices)
        //console.log("scalar_chunks_sb is: ", scalar_chunks)
        verify_gpu_precompute_output(
            input_size,
            subtask_idx,
            num_subtasks,
            max_cluster_size,
            overflow_size,
            scalar_chunks,
            new_point_indices,
            cluster_start_indices,
            cluster_end_indices,
            map,
        )
    }
    return { new_point_indices_sb, cluster_start_indices_sb, cluster_end_indices_sb }

}

const verify_gpu_precompute_output = (
    input_size: number,
    subtask_idx: number,
    num_subtasks: number,
    max_cluster_size: number,
    overflow_size: number,
    scalar_chunks: number[],
    new_point_indices: number[],
    cluster_start_indices: number[],
    cluster_end_indices: number[],
    map_sb: number[],
) => {
    console.log({
        scalar_chunks,
        new_point_indices,
        cluster_start_indices,
        cluster_end_indices,
        max_cluster_size,
        overflow_size,
        map_sb,
    })
    console.log('cluster_start_indices:', cluster_start_indices)
    console.log('cluster_end_indices:', cluster_end_indices)
    console.log('new_point_indices:', new_point_indices)
    console.log('scalar_chunks:', scalar_chunks)
    debugger
    /*
    const num_chunks = input_size / num_subtasks
    // Check that the values in new_point_indices can be used to reconstruct a list of scalar chunks
    // which, when sorted, match the sorted scalar chunks
    const reconstructed = Array(scalar_chunks.length).fill(0)
    const npi = new_point_indices.slice(subtask_idx * num_subtasks, subtask_idx * num_subtasks + num_subtasks)
    for (let i = 0; i < num_subtasks; i ++) {
        reconstructed[i] = scalar_chunks[npi[i]]
    }

    debugger
    const sc_copy = scalar_chunks.map((x) => Number(x))
    const r_copy = reconstructed.map((x) => Number(x))
    sc_copy.sort((a, b) => a - b)
    r_copy.sort((a, b) => a - b)
    assert(sc_copy.toString() === r_copy.toString(), 'new_point_indices invalid')

    // Ensure that cluster_start_indices and cluster_end_indices have
    // the correct structure
    assert(cluster_start_indices.length === cluster_end_indices.length)
    for (let i = 0; i < cluster_start_indices.length; i ++) {
        // start <= end
        assert(cluster_start_indices[i] <= cluster_end_indices[i], `invalid cluster index at ${i}`)
    }
 
    // Check that the cluster start- and end- indices respect
    // max_cluster_size 
    for (let i = 0; i < cluster_start_indices.length; i ++) {
        // end - start <= max_cluster_size
        const d = cluster_end_indices[i] - cluster_start_indices[i]
        assert(d <= max_cluster_size)
    }
 
    // Generate random "points" and compute their linear combination
    // without any preaggregation, then compare the result using an algorithm
    // that uses preaggregation first
    const random_points: bigint[] = []
    for (let i = 0; i < scalar_chunks.length; i ++) {
        //const r = Math.floor(Math.random() * 100000)
        const r = BigInt(1)
        random_points.push(r)
    }

    // Calcualte the linear combination naively
    let lc_result = BigInt(0)
    for (let i = 0; i < scalar_chunks.length; i ++) {
        const prod = BigInt(scalar_chunks[i]) * random_points[i]
        lc_result += BigInt(prod)
    }

    // Calcualte the linear combination with preaggregation
    let preagg_result = BigInt(0)
    for (let i = 0; i < cluster_start_indices.length; i ++) {
        const start_idx = cluster_start_indices[i]
        const end_idx = cluster_end_indices[i]

        if (end_idx === 0) {
            break
        }

        let point = BigInt(random_points[new_point_indices[start_idx]])

        for (let j = cluster_start_indices[i] + 1; j < end_idx; j ++) {
            point += BigInt(random_points[new_point_indices[j]])
        }

        preagg_result += point * BigInt(scalar_chunks[new_point_indices[start_idx]])
    }
    assert(preagg_result === lc_result, 'result mismatch')
    */
}

const genCsrPrecomputeShaderCode = (
    num_y_workgroups: number,
    max_chunk_val: number,
	input_size: number,
    num_subtasks: number,
    max_cluster_size: number,
    overflow_size: number,
) => {
    const shaderCode = mustache.render(
        gen_csr_precompute_shader,
        {
            num_y_workgroups,
            num_subtasks,
            max_cluster_size,
            max_cluster_size_plus_one: max_cluster_size + 1,
            max_chunk_val,
            row_size: input_size / num_subtasks,
            overflow_size,
        },
        {},
    )
    return shaderCode
}

export const pre_aggregation_stage_1_gpu = async (
    device: GPUDevice,
    commandEncoder: GPUCommandEncoder,
    input_size: number,
    point_x_y_sb: GPUBuffer,
    point_t_z_sb: GPUBuffer,
    new_point_indices_sb: GPUBuffer,
    cluster_start_indices_sb: GPUBuffer,
    cluster_end_indices_sb: GPUBuffer,
    debug = false,
): Promise<{
    new_point_x_y_sb: GPUBuffer,
    new_point_t_z_sb: GPUBuffer,
}> => {
    const new_point_x_y_sb = create_sb(device, input_size * 2 * num_words * 4)
    const new_point_t_z_sb = create_sb(device, input_size * 2 * num_words * 4)

    const bindGroupLayout = create_bind_group_layout(
        device,
        [
            'read-only-storage',
            'read-only-storage',
            'read-only-storage',
            'read-only-storage',
            'read-only-storage',
            'storage',
            'storage',
        ],
    )
    const bindGroup = create_bind_group(
        device,
        bindGroupLayout,
        [
            point_x_y_sb,
            point_t_z_sb,
            new_point_indices_sb,
            cluster_start_indices_sb,
            cluster_end_indices_sb,
            new_point_x_y_sb,
            new_point_t_z_sb,
        ],
    )

    const workgroup_size = 64
    const num_x_workgroups = 256
    const num_y_workgroups = input_size / workgroup_size / num_x_workgroups

    const shaderCode = genPreaggregationStage1ShaderCode(
        num_y_workgroups,
        workgroup_size,
    )

    const computePipeline = await create_compute_pipeline(
        device,
        [bindGroupLayout],
        shaderCode,
        'main',
    )

    execute_pipeline(commandEncoder, computePipeline, bindGroup, num_x_workgroups, num_y_workgroups, 1);

    if (debug) {
        const data = await read_from_gpu(
            device,
            commandEncoder,
            [
                new_point_x_y_sb,
                new_point_t_z_sb,
            ],
        )

        const x_y_coords = u8s_to_bigints(data[0], num_words, word_size)
        const t_z_coords = u8s_to_bigints(data[1], num_words, word_size)
        console.log(x_y_coords)
        console.log(t_z_coords)
    }

    return { new_point_x_y_sb, new_point_t_z_sb }
}

const genPreaggregationStage1ShaderCode = (
    num_y_workgroups: number,
    workgroup_size: number,
) => {
    const num_runs = 1
    const word_size = 13
    const misc_params = compute_misc_params(p, word_size)
    const num_words = misc_params.num_words
    const n0 = misc_params.n0
    const mask = BigInt(2) ** BigInt(word_size) - BigInt(1)
    const r = misc_params.r
    const two_pow_word_size = 2 ** word_size
    const p_limbs = gen_p_limbs(p, num_words, word_size)
    const r_limbs = gen_r_limbs(r, num_words, word_size)
    const mu_limbs = gen_mu_limbs(p, num_words, word_size)
    const p_bitlength = p.toString(2).length
    const slack = num_words * word_size - p_bitlength

    const shaderCode = mustache.render(
        preaggregation_stage_1_shader,
        {
            num_y_workgroups,
            workgroup_size,
            word_size,
            num_words,
            n0,
            p_limbs,
            r_limbs,
            mu_limbs,
            w_mask: (1 << word_size) - 1,
            slack,
            num_words_mul_two: num_words * 2,
            num_words_plus_one: num_words + 1,
            mask,
            two_pow_word_size: BigInt(2) ** BigInt(word_size),
        },
        {
            structs,
            bigint_funcs,
            field_funcs,
            ec_funcs,
            montgomery_product_funcs,
        },
    )
    return shaderCode
}

export const pre_aggregation_stage_2_gpu = async (
    device: GPUDevice,
    commandEncoder: GPUCommandEncoder,
    input_size: number,
    scalar_chunks_sb: GPUBuffer,
    cluster_start_indices_sb: GPUBuffer,
    new_point_indices_sb: GPUBuffer,
    debug = false,
): Promise<GPUBuffer> => {
    const new_scalar_chunks_sb = create_sb(device, input_size *  num_words * 4)

    const bindGroupLayout = create_bind_group_layout(
        device,
        [
            'read-only-storage',
            'read-only-storage',
            'read-only-storage',
            'storage',
        ],
    )

    const bindGroup = create_bind_group(
        device,
        bindGroupLayout,
        [
            scalar_chunks_sb,
            new_point_indices_sb,
            cluster_start_indices_sb,
            new_scalar_chunks_sb,
        ],
    )

    const workgroup_size = 64
    const num_x_workgroups = 256
    const num_y_workgroups = input_size / workgroup_size / num_x_workgroups

    const shaderCode = genPreaggregationStage2ShaderCode(
        num_y_workgroups,
        workgroup_size,
    )

    const computePipeline = await create_compute_pipeline(
        device,
        [bindGroupLayout],
        shaderCode,
        'main',
    )

    execute_pipeline(commandEncoder, computePipeline, bindGroup, num_x_workgroups, num_y_workgroups, 1);
    
    if (debug) {
        // TODO
        const data = await read_from_gpu(
            device,
            commandEncoder,
            [new_scalar_chunks_sb],
        )
        const nums = data.map(u8s_to_numbers_32)
        console.log(nums)
    }

    return new_scalar_chunks_sb
}

const genPreaggregationStage2ShaderCode = (
    num_y_workgroups: number,
    workgroup_size: number,
) => {
    const p_limbs = gen_p_limbs(p, num_words, word_size)
    const r_limbs = gen_r_limbs(r, num_words, word_size)
    const mu_limbs = gen_mu_limbs(p, num_words, word_size)
    const shaderCode = mustache.render(
        preaggregation_stage_2_shader,
        {
            num_y_workgroups,
            workgroup_size,
        },
        {
        },
    )
    return shaderCode
}
