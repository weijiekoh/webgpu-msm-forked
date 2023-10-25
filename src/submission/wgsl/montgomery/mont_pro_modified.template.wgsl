{{> bigint_struct }}

@group(0)
@binding(0)
var<storage, read_write> buf: array<BigInt>;

const NUM_WORDS = {{ num_words }}u;
const WORD_SIZE = {{ word_size }}u;
const MASK = {{ mask }}u;
const N0 = {{ n0 }}u;
const NSAFE = {{ nsafe }}u;
const COST = {{ cost }}u;

fn montgomery_product(x: ptr<function, BigInt>, y: ptr<function, BigInt>) -> BigInt {
    var s: BigInt;
    var p = get_p();

    for (var i = 0u; i < NUM_WORDS; i ++) {
        var t = s.limbs[0] + (*x).limbs[i] * (*y).limbs[0];

        var tprime = t & MASK;

        var qi = (N0 * tprime) & MASK;

        var c = (t + qi * p.limbs[0]) >> WORD_SIZE;

        for (var j = 1u; j < NUM_WORDS - 1u; j ++) {
            var t = s.limbs[j] + (*x).limbs[i] * (*y).limbs[j] + qi * p.limbs[j];
            if ((j - 1u) % NSAFE == 0u) {
                t += c;
            }

            c = t >> WORD_SIZE;
            if (j % NSAFE == 0u) {
                c = t >> WORD_SIZE;
                s.limbs[j - 1u] = t & MASK;
            } else {
                s.limbs[j - 1u] = t;
            }
        }

        s.limbs[NUM_WORDS - 2u] = (*x).limbs[i] * (*y).limbs[NUM_WORDS - 1u] + qi * p.limbs[NUM_WORDS - 1u];
    }

    var c = 0u;
    for (var i = 0u; i < NUM_WORDS; i ++) {
        var v = s.limbs[i] + c;
        c = v >> WORD_SIZE;
        s.limbs[i] = v & MASK;
    }

    return conditional_reduce(&s, &p);
}

fn conditional_reduce(x: ptr<function, BigInt>, y: ptr<function, BigInt>) -> BigInt {
    // Determine if x > y
    var x_gt_y = gt(x, y);

    if (x_gt_y == 1u) {
        return sub(x, y);
    }

    return *x;
}

fn gt(x: ptr<function, BigInt>, y: ptr<function, BigInt>) -> u32 {
    for (var idx = 0u; idx < NUM_WORDS; idx ++) {
        var i = NUM_WORDS - 1u - idx;
        if ((*x).limbs[i] < (*y).limbs[i]) {
            return 0u;
        } else if ((*x).limbs[i] > (*y).limbs[i]) {
            return 1u;
        }
    }
    return 0u;
}

fn sub(x: ptr<function, BigInt>, y: ptr<function, BigInt>) -> BigInt {
    var w = MASK + 1u;
    var borrow = 0u;
    var res: BigInt;
    var m = 1u << WORD_SIZE;
    for (var i = 0u; i < NUM_WORDS; i ++) {
        res.limbs[i] = (*x).limbs[i] - (*y).limbs[i] - borrow;
        if ((*x).limbs[i] < (*y).limbs[i] + borrow) {
            res.limbs[i] += w;
            borrow = 1u;
        } else {
            borrow = 0u;
        }
    }
    return res;
}

@compute
@workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let gidx = global_id.x; 
    var a: BigInt = buf[gidx * 2u];
    var b: BigInt = buf[(gidx * 2u) + 1u];

    /*var result = montgomery_product(&a, &b);*/
    var c = montgomery_product(&a, &a);
    for (var i = 1u; i < COST - 1u; i ++) {
        c = montgomery_product(&c, &a);
    }
    var result = montgomery_product(&c, &b);

    buf[gidx] = result;
}