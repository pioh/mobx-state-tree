import { observable, IObservableArray, IArrayWillChange, IArrayWillSplice, IArrayChange, IArraySplice, action, intercept, observe } from "mobx"
import {
    getMSTAdministration,
    getType,
    IJsonPatch,
    maybeMST,
    MSTAdminisration,
    valueToSnapshot,
    applySnapshot
} from "../../core"
import { identity, nothing, invariant } from "../../utils"
import { IType, IComplexType, isType } from "../type"
import { ComplexType } from "./complex-type"
import { getIdentifierAttribute } from "./object"
import { createDefaultValueFactory } from "../utility-types/with-default"

export class ArrayType<T> extends ComplexType<T[], IObservableArray<T>> {
    isArrayFactory = true
    subType: IType<any, any>

    constructor(name: string, subType: IType<any, any>) {
        super(name)
        this.subType = subType
    }

    describe() {
        return this.subType.describe() + "[]"
    }

    createNewInstance() {
        return observable.shallowArray()
    }

    finalizeNewInstance(instance: IObservableArray<any>, snapshot: any) {
        intercept(instance, this.willChange as any)
        observe(instance, this.didChange)
        getMSTAdministration(instance).applySnapshot(snapshot)
    }

    getChildMSTs(node: MSTAdminisration): [string, MSTAdminisration][] {
        const target = node.target as IObservableArray<any>
        const res: [string, MSTAdminisration][] = []
        target.forEach((value, index) => {
            maybeMST(value, childNode => { res.push(["" + index, childNode])})
        })
        return res
    }

    getChildMST(node: MSTAdminisration, key: string): MSTAdminisration | null {
        const target = node.target as IObservableArray<any>
        const index = parseInt(key, 10)
        if (index < target.length)
            return maybeMST(target[index], identity, nothing)
        return null
    }

    willChange = (change: IArrayWillChange<any> | IArrayWillSplice<any>): Object | null => {
        const node = getMSTAdministration(change.object)
        node.assertWritable()

        // TODO: check for key duplication
        switch (change.type) {
            case "update":
                const {newValue} = change
                const oldValue = change.object[change.index]
                if (newValue === oldValue)
                    return null
                change.newValue = node.prepareChild("" + change.index, newValue)
                break
            case "splice":
                change.added = reconcileUnkeyedArrayItems(node, change.object, this.subType, change.index, change.added, change.removedCount)
                break
        }
        return change
    }

    serialize(node: MSTAdminisration): any {
        const target = node.target as IObservableArray<any>
        return target.map(valueToSnapshot)
    }

    didChange(this: {}, change: IArrayChange<any> | IArraySplice<any>): void {
        const node = getMSTAdministration(change.object)
        switch (change.type) {
            case "update":
                return void node.emitPatch({
                    op: "replace",
                    path: "" + change.index,
                    value: valueToSnapshot(change.newValue)
                }, node)
            case "splice":
                for (let i = change.index + change.removedCount - 1; i >= change.index; i--)
                    node.emitPatch({
                        op: "remove",
                        path: "" + i
                    }, node)
                for (let i = 0; i < change.addedCount; i++)
                    node.emitPatch({
                        op: "add",
                        path: "" + (change.index + i),
                        value: valueToSnapshot(change.added[i])
                    }, node)
                return
        }
    }

    applyPatchLocally(node: MSTAdminisration, subpath: string, patch: IJsonPatch): void {
        const target = node.target as IObservableArray<any>
        const index = subpath === "-" ? target.length : parseInt(subpath)
        switch (patch.op) {
            case "replace":
                target[index] = patch.value
                break
            case "add":
                target.splice(index, 0, patch.value)
                break
            case "remove":
                target.splice(index, 1)
                break
        }
    }

    @action applySnapshot(node: MSTAdminisration, snapshot: any[]): void {
        const target = node.target as IObservableArray<any>
        const identifierAttr = getIdentifierAttribute(this.subType)
        if (identifierAttr)
            target.replace(reconcileArrayItems(identifierAttr, target, snapshot, this.subType))
        else
            target.replace(snapshot)
    }

    getChildType(key: string): IType<any, any> {
        return this.subType
    }

    isValidSnapshot(snapshot: any) {
        return Array.isArray(snapshot) && snapshot.every(item => this.subType.is(item))
    }

    getDefaultSnapshot() {
        return []
    }

    removeChild(node: MSTAdminisration, subpath: string) {
        node.target.splice(parseInt(subpath, 10), 1)
    }
}

/**
 * This function reconciles array items, given a splice. Example:
 *
 * Orig array:    [ a a b c]
 *                     ^
 *                    [ d d d ], delete 'b'
 * Splice:        index: 2, remove 1, add 3
 *
 * Reconciled     [ a a b - - c ]
 *                  | | |     |
 *                  v v v + + v
 * To:            [ a a d d d c]
 *
 */
function reconcileUnkeyedArrayItems(node: MSTAdminisration, target: IObservableArray<any>, subtype: IType<any, any>, index: number, added: any[], removedCount: number) {
    // possible optimization: loops instead of splice / map
    const reconcilableCount = Math.min(removedCount, added.length)

    // remove items that won't be reconciled...
    if (removedCount > reconcilableCount) {
        target.slice(index + reconcilableCount, index + removedCount).forEach(oldValue => {
            maybeMST(oldValue, adm => adm.setParent(null))
        })
    }
    // give new indexes to items that will be pushed forward / backward..
    const delta = added.length - removedCount
    target.slice(index + removedCount).forEach((oldValue, idx) => {
        maybeMST(oldValue, adm => adm.setParent(node, "" + (index + removedCount + idx + delta)))
    })

    // reconcile + create new items for the new ones
    const reconciled = added.slice(0, reconcilableCount).map((newValue, pos) =>
        node.prepareChild("" + (index + pos), newValue)
    )
    // for new items, don't reconcile items currently at that position
    const created = added.slice(reconcilableCount).map((newValue, pos) =>
        node.prepareChild("" + (index + pos + reconcilableCount), newValue, false)
    )
    return reconciled.concat(created)
}

function reconcileArrayItems(identifierAttr: string, target: IObservableArray<any>, snapshot: any[], factory: IType<any, any>): any[] {
    const current: any = {}
    target.forEach(item => {
        const id = item[identifierAttr]
        invariant(!current[id], `Identifier '${id}' (of ${getMSTAdministration(item).path}) is not unique!`)
        current[id] = item
    })
    return snapshot.map(item => {
        const existing = current[item[identifierAttr]]
        if (existing && getType(existing).is(item)) {
            applySnapshot(existing, item)
            return existing
        } else {
            return factory.create(item)
        }
    })
}

export function createArrayFactory<S, T>(subtype: IType<S, T>): IComplexType<S[], IObservableArray<T>> {
    return createDefaultValueFactory(new ArrayType(subtype.name + "[]", subtype), [])
}

export function isArrayFactory<S, T>(type: any): type is IComplexType<S[], IObservableArray<T>> {
    return isType(type) && (type as any).isArrayFactory === true
}