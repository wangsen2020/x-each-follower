<script>
import {h} from 'vue';
// Keep native select semantics and events for both Vue and legacy panel controllers.
export default {
  name:'PanelSelect',inheritAttrs:false,
  props:{modelValue:{default:undefined},modelModifiers:{default:()=>({})},truncateSelection:{type:Boolean,default:false}},emits:['update:modelValue'],
  setup(props,{attrs,emit,slots}){
    return ()=>h('select',{...attrs,'data-truncate-selection':props.truncateSelection?'':undefined,...(props.modelValue!==undefined?{value:props.modelValue}:{}),onChange:[event=>{
      const option=event.target.selectedOptions[0];let value=option&&'_value' in option?option._value:event.target.value;
      if(props.modelModifiers.number&&typeof value==='string'&&value.trim()!==''&&!Number.isNaN(Number(value)))value=Number(value);
      emit('update:modelValue',value);
    },attrs.onChange].filter(Boolean)},[...(props.truncateSelection?[h('button',{type:'button',class:'panel-select-trigger'},[h('selectedcontent')])]:[]),...slots.default?.()||[]]);
  }
};
</script>
